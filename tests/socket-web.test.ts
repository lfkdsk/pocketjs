import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import {
  SOCKET_MAX_RECV_QUEUE_BYTES,
  SOCKET_MAX_SEND_QUEUE_BYTES,
  SOCKET_MESSAGE_OVERHEAD_BYTES,
} from "../contracts/spec/socket.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { openSocket, type SocketCloseEvent, type SocketOps } from "../framework/src/socket-api.ts";
import { createSocketHost, type WebSocketHost } from "../hosts/web/socket.js";
import urlTable from "./fixtures/socket-urls.json";

// The browser host over a real WebSocket: Bun's client against a local echo
// server. Delivery still happens only at beginFrame() + the service pump.

let server: ReturnType<typeof Bun.serve>;
let host: WebSocketHost;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, srv) {
      return srv.upgrade(request, { data: undefined }) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, message) {
        if (message === "close-me") ws.close(4001, "bye");
        else ws.send(message);
      },
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  host = createSocketHost(globalThis.WebSocket);
  (globalThis as { socket?: SocketOps }).socket = host.ns;
});

afterEach(() => {
  host.reset();
  delete (globalThis as { socket?: SocketOps }).socket;
});

async function frames(until: () => boolean, deadlineMs = 3000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!until()) {
    if (Date.now() > deadline) throw new Error("socket-web: condition not reached before deadline");
    await Bun.sleep(5);
    host.beginFrame();
    runServicePumps();
  }
}

test("text and binary echo, then a server-initiated close", async () => {
  const url = `ws://127.0.0.1:${server.port}/echo`;
  const socket = openSocket(url);
  const messages: Array<string | Uint8Array> = [];
  const errors: string[] = [];
  let closed: SocketCloseEvent | null = null;
  let opened = false;
  socket.onOpen = () => {
    opened = true;
  };
  socket.onMessage = (data) => messages.push(data);
  socket.onError = (error) => errors.push(error.code);
  socket.onClose = (event) => {
    closed = event;
  };

  await frames(() => opened);
  expect(socket.readyState).toBe("open");
  expect(socket.send("héllo")).toBe(true);
  expect(socket.send(new Uint8Array([0, 1, 254, 255]))).toBe(true);
  await frames(() => messages.length === 2);
  expect(messages[0]).toBe("héllo");
  expect(messages[1]).toBeInstanceOf(Uint8Array);
  expect([...(messages[1] as Uint8Array)]).toEqual([0, 1, 254, 255]);

  expect(socket.send("close-me")).toBe(true);
  await frames(() => closed !== null);
  expect(closed!).toEqual({ code: 4001, reason: "bye", clean: true });
  expect(errors).toEqual([]);
  expect(socket.readyState).toBe("closed");
});

test("a refused connection reports an error then close 1006", async () => {
  // Bind and release a port so nothing listens on it.
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);

  const socket = openSocket(`ws://127.0.0.1:${port}/`, { timeoutMs: 2000 });
  const log: string[] = [];
  let closed = false;
  socket.onOpen = () => log.push("open");
  socket.onError = (error) => log.push(`error ${error.code}`);
  socket.onClose = (event) => {
    closed = true;
    log.push(`close ${event.code} ${event.clean}`);
  };
  await frames(() => closed);
  expect(log).toHaveLength(2);
  expect(log[0]).toBe("error connect");
  expect(log[1]).toBe("close 1006 false");
});

// --- scripted transport: the test plays the browser --------------------------

const META = JSON.stringify({ protocols: [], timeoutMs: 1000 });
const OVERHEAD = SOCKET_MESSAGE_OVERHEAD_BYTES;

class ScriptedSocket extends EventTarget {
  static instances: ScriptedSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "";
  protocol = "";
  sends = 0;

  constructor(_url: string, _protocols?: string[]) {
    super();
    ScriptedSocket.instances.push(this);
  }

  /** Never drains: every payload byte stays buffered until the test clears it. */
  send(payload: string | ArrayBuffer) {
    this.sends++;
    this.bufferedAmount += typeof payload === "string" ? new TextEncoder().encode(payload).byteLength : payload.byteLength;
  }

  close() {
    if (this.readyState < 2) this.readyState = 2;
  }

  fire(type: string, fields: Record<string, unknown> = {}) {
    const event = new Event(type);
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
    this.dispatchEvent(event);
  }
}

function scripted(): { fake: WebSocketHost; open(url?: string): [number, ScriptedSocket] } {
  ScriptedSocket.instances.length = 0;
  const fake = createSocketHost(ScriptedSocket);
  return {
    fake,
    open(url = "ws://example.test/socket") {
      const handle = fake.ns.open(url, META);
      expect(handle).toBeGreaterThan(0);
      return [handle, ScriptedSocket.instances.at(-1)!];
    },
  };
}

function openNow(fake: WebSocketHost, socket: ScriptedSocket, handle: number): void {
  socket.readyState = 1;
  socket.fire("open");
  fake.beginFrame();
  expect(JSON.parse(fake.ns.poll()!)).toEqual([{ t: "open", h: handle, protocol: "" }]);
}

test("empty outbound messages are charged the per-message overhead", () => {
  const { fake, open } = scripted();
  const [handle, socket] = open();
  openNow(fake, socket, handle);
  const limit = SOCKET_MAX_SEND_QUEUE_BYTES / OVERHEAD;
  const empty = new ArrayBuffer(0);
  expect(fake.ns.send(handle, empty, false)).toBe(OVERHEAD);
  let accepted = 1;
  for (let i = 1; i < 100_000; i++) if (fake.ns.send(handle, empty, false) >= 0) accepted++;
  expect(accepted).toBe(limit);
  expect(socket.sends).toBe(limit);
  expect(fake.ns.lastError()).toStartWith("backpressure:");

  // bufferedAmount 0 at the boundary: everything was written.
  fake.beginFrame();
  expect(fake.ns.send(handle, empty, false)).toBe(OVERHEAD);
  fake.reset();
});

test("outbound payload stays charged until the browser reports it written", () => {
  const { fake, open } = scripted();
  const [handle, socket] = open();
  openNow(fake, socket, handle);
  const byte = new Uint8Array([1]).buffer;
  let accepted = 0;
  while (fake.ns.send(handle, byte, false) >= 0) accepted++;
  expect(accepted).toBe(Math.floor(SOCKET_MAX_SEND_QUEUE_BYTES / (1 + OVERHEAD)));
  expect(socket.bufferedAmount).toBe(accepted);

  fake.beginFrame(); // nothing written: the charge stays
  expect(fake.ns.send(handle, byte, false)).toBe(-1);
  socket.bufferedAmount = 1; // all but the last message written
  fake.beginFrame();
  expect(fake.ns.send(handle, byte, false)).toBe(2 * (1 + OVERHEAD));
  socket.bufferedAmount = 0;
  fake.beginFrame();
  expect(fake.ns.send(handle, byte, false)).toBe(1 + OVERHEAD);
  fake.reset();
});

test("empty inbound messages are charged the overhead and overflow the receive bound", () => {
  const { fake, open } = scripted();
  const [handle, socket] = open();
  openNow(fake, socket, handle);
  for (let i = 0; i < 100_000; i++) socket.fire("message", { data: "" });

  let delivered = 0;
  const terminal: unknown[] = [];
  for (let frame = 0; frame < 200 && terminal.length < 2; frame++) {
    fake.beginFrame();
    const batch = fake.ns.poll();
    if (!batch) continue;
    for (const event of JSON.parse(batch)) {
      if (event.t === "message") delivered++;
      else terminal.push(event);
    }
  }
  expect(delivered).toBe(SOCKET_MAX_RECV_QUEUE_BYTES / OVERHEAD);
  expect(terminal).toEqual([
    { t: "error", h: handle, code: "overflow", message: expect.any(String) },
    { t: "close", h: handle, code: 1006, reason: "", clean: false },
  ]);
  fake.reset();
});

test("close while connecting ends with exactly one close 1006", () => {
  const { fake, open } = scripted();
  const [handle] = open();
  expect(fake.ns.close(handle, 1000, "cancel")).toBe(0);
  fake.beginFrame();
  expect(JSON.parse(fake.ns.poll()!)).toEqual([{ t: "close", h: handle, code: 1006, reason: "", clean: false }]);
  fake.beginFrame();
  expect(fake.ns.poll()).toBeUndefined();
  fake.reset();
});

test("close before open drops a transport error that is not yet admitted", async () => {
  const { fake, open } = scripted();
  const [refused, socket] = open();
  socket.readyState = 3; // the browser failed the connection
  socket.fire("error");
  expect(fake.ns.close(refused, 1000, "")).toBe(0);
  socket.fire("close", { code: 1006, reason: "", wasClean: false });

  const slow = fake.ns.open("ws://example.test/slow", JSON.stringify({ protocols: [], timeoutMs: 1 }));
  await Bun.sleep(10); // the handshake timeout fires before close()
  expect(fake.ns.close(slow, 1000, "")).toBe(0);

  fake.beginFrame();
  expect(JSON.parse(fake.ns.poll()!)).toEqual([
    { t: "close", h: refused, code: 1006, reason: "", clean: false },
    { t: "close", h: slow, code: 1006, reason: "", clean: false },
  ]);
  fake.reset();
});

test("close before the open event aborts a handshake that already completed", () => {
  const { fake, open } = scripted();
  const [handle, socket] = open();
  socket.readyState = 1;
  socket.fire("open"); // transport open, not yet admitted
  socket.fire("message", { data: "early" });
  expect(fake.ns.close(handle, 3001, "nope")).toBe(0);
  socket.fire("close", { code: 3001, reason: "nope", wasClean: true });
  fake.beginFrame();
  expect(JSON.parse(fake.ns.poll()!)).toEqual([{ t: "close", h: handle, code: 1006, reason: "", clean: false }]);
  fake.reset();
});

test("socket URLs need a host and a port in 1..65535", () => {
  const { fake } = scripted();
  for (const url of [
    "ws://:",
    "ws://:80",
    "ws://h:",
    "ws://h:0",
    "ws://h:65536",
    "ws://h:8a",
    "ws://h:000001",
    "ws://u@h",
    "ws://[]",
    "ws://[zz]",
    "ws://[::1",
    "ws://h]",
    "ws://hé",
    "ws:///p",
    "ws://?q",
    "ws://h#f",
  ]) {
    expect([url, fake.ns.open(url, META)]).toEqual([url, -1]);
    expect(fake.ns.lastError()).toStartWith("invalid_request:");
  }
  expect(ScriptedSocket.instances).toHaveLength(0);

  for (const url of [
    "ws://h",
    "wss://h:443/p?q=1",
    "ws://127.0.0.1:8080/x",
    "ws://[::1]:9000/",
    "ws://a-b.c_d~e",
    "ws://h:65535?x",
    "ws://h/é",
  ]) {
    const handle = fake.ns.open(url, META);
    expect([url, handle > 0]).toEqual([url, true]);
    fake.ns.close(handle, 1000, "");
    fake.beginFrame();
    fake.ns.poll();
  }
  fake.reset();
});

test("the shared URL table is decided before the transport, identically to pocket-socket", () => {
  const { fake } = scripted();
  for (const url of urlTable.invalid) {
    expect([url, fake.ns.open(url, META)]).toEqual([url, -1]);
    expect(fake.ns.lastError()).toStartWith("invalid_request:");
  }
  expect(ScriptedSocket.instances).toHaveLength(0);

  for (const url of urlTable.valid) {
    // Stricter than WHATWG URL, never looser: every accepted URL parses.
    expect(() => new URL(url)).not.toThrow();
    const handle = fake.ns.open(url, META);
    expect([url, handle > 0]).toEqual([url, true]);
    fake.ns.close(handle, 1000, "");
    fake.beginFrame();
    fake.ns.poll();
  }
  expect(ScriptedSocket.instances).toHaveLength(urlTable.valid.length);
  fake.reset();
});
