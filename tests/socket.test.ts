import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  SOCKET_ERROR,
  SOCKET_MAX_EVENTS_PER_TICK,
  SOCKET_MAX_MESSAGE_BYTES,
  SOCKET_MAX_SEND_QUEUE_BYTES,
  SOCKET_MESSAGE_OVERHEAD_BYTES,
} from "../contracts/spec/socket.ts";
import { runServicePumps } from "../framework/src/services.ts";
import {
  openSocket,
  SocketError,
  type PocketSocket,
  type SocketOps,
} from "../framework/src/socket-api.ts";
import { createSocketHost, type WebSocketHost } from "../hosts/web/socket.js";
import urlTable from "./fixtures/socket-urls.json";

type Listener = (event: Record<string, unknown>) => void;

/** Scripted stand-in for the browser WebSocket: the test plays the network. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  protocol = "";
  binaryType = "blob";
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closeCalls: Array<[number | undefined, string | undefined]> = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error("InvalidStateError");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    if (this.readyState < 2) this.readyState = 2;
  }

  private emit(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  serverOpen(protocol = ""): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.emit("open");
  }

  serverText(data: string): void {
    this.emit("message", { data });
  }

  serverBinary(bytes: Uint8Array): void {
    this.emit("message", { data: bytes.slice().buffer });
  }

  serverError(): void {
    this.emit("error");
  }

  serverClose(code = 1000, reason = "", wasClean = true): void {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean });
  }
}

let host: WebSocketHost;
const ws = (i: number) => FakeWebSocket.instances[i];

function tick(): void {
  host.beginFrame();
  runServicePumps();
}

function track(socket: PocketSocket, log: string[], name = "s"): PocketSocket {
  socket.onOpen = () => log.push(`${name} open ${socket.protocol}`);
  socket.onMessage = (data) =>
    log.push(typeof data === "string" ? `${name} text ${data}` : `${name} binary ${[...data].join(",")}`);
  socket.onError = (error) => log.push(`${name} error ${error.code}`);
  socket.onClose = (event) => log.push(`${name} close ${event.code} ${event.reason} ${event.clean}`);
  return socket;
}

function opened(log: string[], name = "s"): [PocketSocket, FakeWebSocket] {
  const socket = track(openSocket("ws://example.test/live"), log, name);
  const fake = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  fake.serverOpen();
  tick();
  expect(socket.readyState).toBe("open");
  return [socket, fake];
}

function expectRefusal(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SocketError);
  expect((caught as SocketError).code).toBe(code as SocketError["code"]);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  host = createSocketHost(FakeWebSocket);
  (globalThis as { socket?: SocketOps }).socket = host.ns;
});

afterEach(() => {
  // Finish every connection the test left open so the SDK's realm-wide state
  // (live sockets, service pump) is empty for the next test.
  for (const fake of FakeWebSocket.instances) {
    if (fake.readyState !== 3) fake.serverClose(1006, "", false);
  }
  for (let i = 0; i < 4; i++) {
    try {
      tick();
    } catch {
      // callback errors of the test under cleanup
    }
  }
  host.reset();
  delete (globalThis as { socket?: SocketOps }).socket;
});

describe("socket SDK + browser host over a scripted WebSocket", () => {
  test("transport facts are visible only after beginFrame and the service pump", () => {
    const log: string[] = [];
    const socket = track(openSocket("ws://example.test/chat", { protocols: ["chat.v1"] }), log);
    expect(socket.readyState).toBe("connecting");
    expect(ws(0).url).toBe("ws://example.test/chat");
    expect(ws(0).protocols).toEqual(["chat.v1"]);
    expect(ws(0).binaryType).toBe("arraybuffer");

    ws(0).serverOpen("chat.v1");
    ws(0).serverText("héllo");
    ws(0).serverBinary(new Uint8Array([1, 2, 255]));
    ws(0).serverClose(4000, "done", true);
    runServicePumps();
    expect(log).toEqual([]);
    host.beginFrame();
    expect(log).toEqual([]);
    runServicePumps();
    expect(log).toEqual([
      "s open chat.v1",
      "s text héllo",
      "s binary 1,2,255",
      "s close 4000 done true",
    ]);
    expect(socket.readyState).toBe("closed");
    expect(socket.protocol).toBe("chat.v1");
  });

  test("binary messages arrive as an owned Uint8Array", () => {
    const received: Array<string | Uint8Array> = [];
    const [socket, fake] = opened([]);
    socket.onMessage = (data) => received.push(data);
    const sent = new Uint8Array([9, 8, 7, 6]);
    fake.serverBinary(sent);
    tick();
    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(Uint8Array);
    expect([...(received[0] as Uint8Array)]).toEqual([9, 8, 7, 6]);
  });

  test("send copies text and binary payloads and reports backpressure", () => {
    const [socket, fake] = opened([]);
    expect(socket.send("hi ✓")).toBe(true);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(socket.send(bytes.subarray(1))).toBe(true);
    bytes[1] = 0;
    expect(fake.sent[0]).toBe("hi ✓");
    expect([...new Uint8Array(fake.sent[1] as ArrayBuffer)]).toEqual([2, 3]);

    // Both sent messages are still buffered: their overhead stays charged.
    fake.bufferedAmount = SOCKET_MAX_SEND_QUEUE_BYTES - 3 * SOCKET_MESSAGE_OVERHEAD_BYTES - 4;
    tick(); // queued bytes are sampled at the tick boundary
    expect(socket.send("hello")).toBe(false);
    expect(socket.send("hey")).toBe(true);
    expect(fake.sent).toHaveLength(3);

    fake.bufferedAmount = 0;
    tick(); // written bytes are credited back at the next boundary
    expect(socket.send("hello")).toBe(true);
    expectRefusal(() => socket.send(new Uint8Array(SOCKET_MAX_MESSAGE_BYTES + 1)), SOCKET_ERROR.messageTooLarge);
  });

  test("the host returns the queued byte count and refuses invalid UTF-8 text", () => {
    const ns = host.ns;
    const handle = ns.open("ws://example.test/raw", '{"protocols":[],"timeoutMs":1000}');
    expect(handle).toBeGreaterThan(0);
    ws(0).serverOpen();
    host.beginFrame();
    expect(ns.poll()).toBe(`[{"t":"open","h":${handle},"protocol":""}]`);
    expect(ns.send(handle, new Uint8Array([1, 2, 3]).buffer, false)).toBe(3 + SOCKET_MESSAGE_OVERHEAD_BYTES);
    expect(ns.send(handle, new Uint8Array([0x61]).buffer, true)).toBe(4 + 2 * SOCKET_MESSAGE_OVERHEAD_BYTES);
    expect(ns.send(handle, new Uint8Array([0xff]).buffer, true)).toBe(-1);
    expect(ns.lastError()).toStartWith("invalid_request:");
    expect(ns.close(handle, 1001, "")).toBe(-1);
    expect(ns.close(handle, 3000, "x".repeat(124))).toBe(-1);
    expect(ns.close(handle, 3000, "bye")).toBe(0);
    expect(ns.close(handle, 3000, "bye")).toBe(0); // idempotent while closing
    expect(ws(0).closeCalls).toEqual([[3000, "bye"]]);
    expect(ns.send(handle, new Uint8Array([1]).buffer, false)).toBe(-1);
    expect(ns.lastError()).toStartWith("closed:");
    ws(0).serverClose(3000, "bye", true);
    host.beginFrame();
    expect(JSON.parse(ns.poll()!)).toEqual([{ t: "close", h: handle, code: 3000, reason: "bye", clean: true }]);
    expect(ns.close(handle, 1000, "")).toBe(-1); // released by the poll above
  });

  test("send on a socket that is not open throws closed", () => {
    const log: string[] = [];
    const socket = track(openSocket("ws://example.test/x"), log);
    expectRefusal(() => socket.send("early"), SOCKET_ERROR.closed);
    ws(0).serverOpen();
    tick();
    socket.close();
    expect(socket.readyState).toBe("closing");
    expectRefusal(() => socket.send("late"), SOCKET_ERROR.closed);
    expectRefusal(() => socket.close(1001), SOCKET_ERROR.invalidRequest);
    expectRefusal(() => socket.close(1000, "é".repeat(62)), SOCKET_ERROR.invalidRequest);
    socket.close(); // idempotent
    expect(ws(0).closeCalls).toEqual([[1000, ""]]);
  });

  test("at most SOCKET_MAX_EVENTS_PER_TICK events cross per tick", () => {
    const received: string[] = [];
    const [socket, fake] = opened([]);
    socket.onMessage = (data) => received.push(data as string);
    for (let i = 0; i < 70; i++) fake.serverText(String(i));
    tick();
    expect(received).toHaveLength(SOCKET_MAX_EVENTS_PER_TICK);
    tick();
    expect(received).toHaveLength(70);
    expect(received[69]).toBe("69");
  });

  test("an untaken binary body is dropped by the next poll", () => {
    const ns = host.ns;
    const handle = ns.open("ws://example.test/raw", '{"protocols":[],"timeoutMs":1000}');
    ws(0).serverOpen();
    ws(0).serverBinary(new Uint8Array([4, 5]));
    ws(0).serverBinary(new Uint8Array([6]));
    host.beginFrame();
    const events = JSON.parse(ns.poll()!);
    expect(events[1]).toEqual({ t: "message", h: handle, text: false, m: 1, bytes: 2 });
    expect(ns.take(1, new ArrayBuffer(3))).toBe(-1); // wrong size
    const into = new ArrayBuffer(2);
    expect(ns.take(1, into)).toBe(2);
    expect([...new Uint8Array(into)]).toEqual([4, 5]);
    expect(ns.take(1, into)).toBe(-1); // at most once
    expect(ns.poll()).toBeUndefined();
    expect(ns.take(2, new ArrayBuffer(1))).toBe(-1); // dropped by that poll
    ws(0).serverClose();
    host.beginFrame();
    expect(ns.poll()).toContain('"t":"close"');
  });

  test("the connection limit counts handles until their close is polled", () => {
    const log: string[] = [];
    const sockets = [0, 1, 2, 3].map((i) => track(openSocket(`ws://example.test/${i}`), log, `s${i}`));
    expectRefusal(() => openSocket("ws://example.test/5"), SOCKET_ERROR.busy);
    ws(0).serverClose(1006, "", false);
    expectRefusal(() => openSocket("ws://example.test/5"), SOCKET_ERROR.busy);
    host.beginFrame();
    expectRefusal(() => openSocket("ws://example.test/5"), SOCKET_ERROR.busy);
    runServicePumps();
    expect(log).toEqual(["s0 close 1006  false"]);
    expect(sockets[0].readyState).toBe("closed");
    const fifth = openSocket("ws://example.test/5");
    expect(fifth.readyState).toBe("connecting");
    expect(FakeWebSocket.instances).toHaveLength(5);
  });

  test("invalid requests are refused before the transport sees them", () => {
    for (const url of [
      "http://example.test/",
      "ws://",
      "ws:///path",
      "ws://?q",
      "ws://example.test/#frag",
      "ws://example .test/",
      `ws://example.test/${"a".repeat(2048)}`,
      "ws://:",
      "ws://:80/",
      "ws://example.test:/",
      "ws://example.test:0/",
      "ws://example.test:65536/",
      "ws://user@example.test/",
      "ws://[]/",
    ]) {
      expectRefusal(() => openSocket(url), SOCKET_ERROR.invalidRequest);
    }
    for (const protocols of [["a b"], ["x", "x"], [""], Array.from({ length: 9 }, (_, i) => `p${i}`)]) {
      expectRefusal(() => openSocket("ws://example.test/", { protocols }), SOCKET_ERROR.invalidRequest);
    }
    for (const timeoutMs of [0, 1.5, 60_001]) {
      expectRefusal(() => openSocket("ws://example.test/", { timeoutMs }), SOCKET_ERROR.invalidRequest);
    }
    expect(FakeWebSocket.instances).toHaveLength(0);

    const ns = host.ns;
    expect(ns.open("ws://example.test/", "{bad")).toBe(-1);
    expect(ns.lastError()).toBe("invalid_request: malformed open metadata");
    expect(ns.open("ws://example.test/", '{"protocols":[],"timeoutMs":0}')).toBe(-1);
    expect(ns.open("wss://example.test/", '{"protocols":["a","a"],"timeoutMs":5}')).toBe(-1);
    expect(ns.open("ws://example.test/#x", '{"protocols":[],"timeoutMs":5}')).toBe(-1);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test("the shared URL table is decided before the host op, identically to pocket-socket", () => {
    const opened: string[] = [];
    const ops: SocketOps = {
      ...host.ns,
      open: (url, metaJson) => {
        opened.push(url);
        return host.ns.open(url, metaJson);
      },
    };
    (globalThis as { socket?: SocketOps }).socket = ops;
    for (const url of urlTable.invalid) {
      expectRefusal(() => openSocket(url), SOCKET_ERROR.invalidRequest);
    }
    expect(opened).toEqual([]);
    for (const url of urlTable.valid) {
      const socket = openSocket(url);
      expect(opened.at(-1)).toBe(url);
      socket.close();
      tick();
      expect([url, socket.readyState]).toEqual([url, "closed"]);
    }
    expect(opened).toEqual(urlTable.valid);
    (globalThis as { socket?: SocketOps }).socket = host.ns;
  });

  test("an unmounted or incomplete module is unavailable", () => {
    delete (globalThis as { socket?: SocketOps }).socket;
    let caught: unknown;
    try {
      openSocket("ws://example.test/");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SocketError);
    expect(caught).toMatchObject({
      code: SOCKET_ERROR.unavailable,
      message: "socket: host did not mount the socket module",
    });
    (globalThis as { socket?: unknown }).socket = { open: () => 1 };
    expectRefusal(() => openSocket("ws://example.test/"), SOCKET_ERROR.unavailable);
  });

  test("close while connecting reports no open and exactly one close", () => {
    const log: string[] = [];
    const socket = track(openSocket("ws://example.test/a"), log);
    socket.close();
    expect(socket.readyState).toBe("closing");
    expect(ws(0).closeCalls).toHaveLength(1);
    ws(0).serverOpen(); // the browser's late facts for an aborted socket
    ws(0).serverError();
    ws(0).serverClose(1006, "", false);
    tick();
    tick();
    expect(log).toEqual(["s close 1006  false"]);
    expect(socket.readyState).toBe("closed");

    // An open fact already queued before close() is not reported either: the
    // guest never saw `open`, so the attempt is aborted with 1006.
    const late = track(openSocket("ws://example.test/b"), log, "late");
    ws(1).serverOpen();
    late.close(3001, "nope");
    expect(ws(1).closeCalls).toEqual([[undefined, undefined]]);
    ws(1).serverClose(3001, "nope", true);
    tick();
    expect(log.slice(1)).toEqual(["late close 1006  false"]);
  });

  test("a connect timeout reports timeout then close 1006", async () => {
    const log: string[] = [];
    const socket = track(openSocket("ws://example.test/slow", { timeoutMs: 10 }), log);
    await Bun.sleep(30);
    expect(log).toEqual([]);
    tick();
    expect(log).toEqual(["s error timeout", "s close 1006  false"]);
    expect(socket.readyState).toBe("closed");
    expect(ws(0).closeCalls).toHaveLength(1);
    ws(0).serverOpen(); // ignored: the transport already ended
    ws(0).serverClose();
    host.beginFrame();
    expect(host.ns.poll()).toBeUndefined();
  });

  test("a browser error before open maps to connect", () => {
    const log: string[] = [];
    track(openSocket("ws://example.test/refused"), log);
    ws(0).serverError();
    ws(0).serverClose(1006, "", false);
    tick();
    expect(log).toEqual(["s error connect", "s close 1006  false"]);
  });

  test("an oversized inbound message fails the connection with 1009", () => {
    const log: string[] = [];
    const [, fake] = opened(log);
    fake.serverBinary(new Uint8Array(SOCKET_MAX_MESSAGE_BYTES + 1));
    fake.serverText("after"); // ignored
    expect(fake.closeCalls).toHaveLength(1);
    tick();
    expect(log).toEqual(["s open ", "s error message_too_large", "s close 1009  false"]);
  });

  test("undelivered inbound bytes above the receive bound fail with overflow", () => {
    const log: string[] = [];
    const [socket, fake] = opened(log);
    socket.onMessage = () => log.push("message");
    // Four messages charged with their overhead fill the bound exactly.
    const chunk = new Uint8Array(SOCKET_MAX_MESSAGE_BYTES - SOCKET_MESSAGE_OVERHEAD_BYTES);
    for (let i = 0; i < 5; i++) fake.serverBinary(chunk);
    expect(fake.closeCalls).toHaveLength(1);
    tick();
    expect(log).toEqual(["s open ", "message", "message", "message", "message", "s error overflow", "s close 1006  false"]);
  });

  test("a throwing callback does not stop the batch and is rethrown after it", () => {
    const log: string[] = [];
    const [a, fakeA] = opened(log, "a");
    const [, fakeB] = opened(log, "b");
    a.onMessage = () => {
      throw new Error("boom");
    };
    fakeA.serverText("1");
    fakeB.serverText("2");
    fakeA.serverClose(1000, "", true);
    expect(() => tick()).toThrow("boom");
    expect(log.slice(2)).toEqual(["b text 2", "a close 1000  true"]);
  });

  test("a malformed batch fails every live socket with protocol + 1006", () => {
    const log: string[] = [];
    let batch: string | undefined = "not json";
    const ops: SocketOps = {
      open: () => 7,
      send: () => -1,
      close: () => 0,
      poll: () => {
        const out = batch;
        batch = undefined;
        return out;
      },
      take: () => -1,
      lastError: () => "",
    };
    (globalThis as { socket?: SocketOps }).socket = ops;
    const socket = track(openSocket("ws://example.test/"), log);
    runServicePumps();
    expect(log).toEqual(["s error protocol", "s close 1006  false"]);
    expect(socket.readyState).toBe("closed");
    // The abandoned handle is polled until the core reports its close.
    batch = '[{"t":"close","h":7,"code":1000,"reason":"","clean":true}]';
    runServicePumps();
    expect(batch).toBeUndefined();
    expect(log).toHaveLength(2);
    (globalThis as { socket?: SocketOps }).socket = host.ns;
  });
});
