import { describe, expect, test } from "bun:test";
import {
  createSurfaceCatalog,
  focusCanvas,
  mountPocketSystem,
  validateSystemPlan,
} from "../hosts/web/system-engine.js";
import { validateAndResolveSystemPlan } from "@pocketjs/framework/manifest";
import systemInput from "./fixtures/systems/managed-desktop.json";

async function resolvedWebSystem() {
  const installed = new Set(systemInput.installation.installedPackages);
  const packages = await Promise.all(
    systemInput.applications.catalog
      .filter((entry) => installed.has(entry.package))
      .map(async (entry) => ({
        source: entry.manifest,
        manifest: await Bun.file(entry.manifest).json(),
      })),
  );
  const result = validateAndResolveSystemPlan(systemInput, {
    target: "web-app",
    packages,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

/** The resolver hands back a deeply readonly plan. The rejection tests
 *  deliberately corrupt a clone of one, so they need a writable view of it. */
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type WebSystemPlan = Awaited<ReturnType<typeof resolvedWebSystem>>;

async function corruptibleWebSystem(): Promise<Mutable<WebSystemPlan>> {
  return structuredClone(await resolvedWebSystem()) as Mutable<WebSystemPlan>;
}

describe("browser Pocket System host", () => {
  test("focusing the canvas cannot move a double-click onto another surface", () => {
    let options: FocusOptions | undefined;
    focusCanvas({
      focus(next: FocusOptions) {
        options = next;
      },
    });
    expect(options).toEqual({ preventScroll: true });
  });

  test("assigns one-based compositor handles in installation order", async () => {
    const plan = await resolvedWebSystem();
    const { catalog, surfaces } = createSurfaceCatalog(plan.applications);
    expect(catalog.get(0)).toBeUndefined();
    expect(catalog.get(1)).toBe(plan.applications[0]);
    expect(surfaces[plan.applications[0].package]).toBe(1);
    expect(surfaces[plan.applications[1].package]).toBe(2);
  });

  test("accepts a complete resolved web System plan", async () => {
    const plan = await resolvedWebSystem();
    expect(() => validateSystemPlan(plan)).not.toThrow();
  });

  test("rejects child companions and artifact collisions at its trust boundary", async () => {
    const companions = await corruptibleWebSystem();
    companions.applications[0].plan.companions = ["note"];
    expect(() => validateSystemPlan(companions)).toThrow("unsupported companions");

    const collision = await corruptibleWebSystem();
    collision.applications[1].plan.app.output = collision.applications[0].plan.app.output;
    expect(() => validateSystemPlan(collision)).toThrow("duplicate or missing artifact output");
  });
});

// ---------------------------------------------------------------------------
// NET and SOCKET in the production web-app host. mountPocketSystem runs here
// against a minimal fake DOM: every iframe Realm is a plain object whose
// PocketAppInstance factory records which globals it saw, and whose step()
// polls the realm's net/socket namespaces the way a guest frame() does. The
// System page's fetch/WebSocket are scripted fakes, so transport facts land
// between ticks and the test observes when they become guest-visible.

type FakeListener = (event: Record<string, unknown>) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, FakeListener[]>();
  binaryType = "blob";
  bufferedAmount = 0;
  protocol = "";
  closed = false;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: FakeListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send() {}
  close() {
    this.closed = true;
  }
}

/** A realm-local WebSocket/fetch the host must not use as the transport. */
class RealmWebSocket {
  constructor() {
    throw new Error("the System host used the iframe realm's WebSocket");
  }
}

interface FakeRealm {
  packageId: string;
  window: Record<string, any>;
  removed: boolean;
  /** Namespaces present when the bundle would evaluate (inside create()). */
  atCreate: { net: string[]; socket: string[] };
  /** What each guest frame() saw from poll() after the tick boundary. */
  frames: Array<{ net: unknown; socket: unknown }>;
}

const NET_OPS = ["cancel", "lastError", "poll", "start", "take"];
const SOCKET_OPS = ["close", "lastError", "open", "poll", "send", "take"];
const OPEN_META = JSON.stringify({ protocols: [], timeoutMs: 5000 });
const GET_META = (url: string) =>
  JSON.stringify({ url, method: "GET", headers: {}, timeoutMs: 5000, maxBytes: 64 });
const parse = (batch: unknown) => (typeof batch === "string" ? JSON.parse(batch) : []);

async function mountFakeSystem() {
  const plan = await resolvedWebSystem();
  const realms: FakeRealm[] = [];
  const fetches: Array<{ url: string; signal: AbortSignal }> = [];
  let rafCallback: ((now: number) => Promise<void>) | null = null;
  let clock = performance.now();
  const shellState = {
    bindings: [] as Array<{ handle: number }>,
    frames: [] as Array<Record<string, unknown>>,
  };
  const listeners = { addEventListener() {}, removeEventListener() {} };

  const fakeFetch = async (url: string, init: { signal: AbortSignal }) => {
    if (url.endsWith("pocket.system.plan.json")) return Response.json(plan);
    fetches.push({ url, signal: init.signal });
    if (url.endsWith("/hang")) {
      return new Promise<Response>((_, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    return new Response("ok", { status: 200 });
  };

  function realmWindow(): Record<string, any> {
    const win: Record<string, any> = {
      WebSocket: RealmWebSocket,
      fetch: () => {
        throw new Error("the System host used the iframe realm's fetch");
      },
    };
    win.PocketAppInstance = {
      async create(options: Record<string, any>) {
        const realm = realms.find((entry) => entry.window === win)!;
        realm.packageId = options.packageId;
        realm.atCreate = {
          net: Object.keys(win.net ?? {}).sort(),
          socket: Object.keys(win.socket ?? {}).sort(),
        };
        const viewport = [...options.viewport];
        const isShell = options.packageId === plan.systemUI.package;
        return {
          viewport,
          step() {
            realm.frames.push({ net: parse(win.net?.poll()), socket: parse(win.socket?.poll()) });
          },
          render: () => new Uint8Array(viewport[0] * viewport[1] * 4),
          renderComposited: () => new Uint8Array(0),
          bindings: () => (isShell ? shellState.bindings : []),
          frames: () => (isShell ? shellState.frames : []),
          uploadSurface: () => 0,
          freeSurface() {},
          sendService() {},
          drainService: () => [],
          resize() {},
          dispose() {},
        };
      },
    };
    return win;
  }

  const saved = {
    document: (globalThis as any).document,
    window: (globalThis as any).window,
    location: (globalThis as any).location,
    requestAnimationFrame: (globalThis as any).requestAnimationFrame,
    cancelAnimationFrame: (globalThis as any).cancelAnimationFrame,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
  };
  Object.assign(globalThis, {
    location: { href: "http://pocket.test/" },
    window: listeners,
    requestAnimationFrame: (callback: (now: number) => Promise<void>) => {
      rafCallback = callback;
      return 1;
    },
    cancelAnimationFrame() {},
    fetch: fakeFetch,
    WebSocket: FakeWebSocket,
    document: {
      body: {
        appendChild(iframe: any) {
          queueMicrotask(() => iframe.loaded());
        },
      },
      createElement() {
        const onLoad: Array<() => void> = [];
        const realm = {
          packageId: "",
          window: realmWindow(),
          removed: false,
          atCreate: { net: [], socket: [] },
          frames: [],
        } as FakeRealm;
        realms.push(realm);
        return {
          contentWindow: realm.window,
          setAttribute() {},
          addEventListener(type: string, listener: () => void) {
            if (type === "load") onLoad.push(listener);
          },
          loaded() {
            for (const listener of onLoad) listener();
          },
          remove() {
            realm.removed = true;
          },
        };
      },
    },
  });
  const restore = () => Object.assign(globalThis, saved);

  const canvas = {
    width: 0,
    height: 0,
    style: {},
    ...listeners,
    focus() {},
    getContext: () => ({
      imageSmoothingEnabled: true,
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData() {},
    }),
  };

  const bind = (handles: number[]) => {
    shellState.bindings = handles.map((handle) => ({ handle }));
    shellState.frames = handles.map((handle, order) => ({
      handle,
      focused: order === handles.length - 1,
      order,
      full: [0, 0, 100, 100],
    }));
  };

  try {
    bind([1, 2]);
    const system = await mountPocketSystem(canvas, {
      planUrl: "http://pocket.test/pocket.system.plan.json",
      liveResize: false,
    });
    const realm = (id: string) => realms.find((entry) => entry.packageId === id)!;
    return {
      plan,
      system,
      fetches,
      bind,
      restore,
      shell: realm(plan.systemUI.package),
      first: realm(plan.applications[0].package),
      second: realm(plan.applications[1].package),
      /** One rAF callback that runs exactly one fixed 60 Hz System step. */
      async tick() {
        clock += 1000 / 60 + 1;
        await rafCallback!(clock);
      },
    };
  } catch (error) {
    restore();
    throw error;
  }
}

describe("browser Pocket System host network modules", () => {
  test("installs one net and one socket host into each package Realm before its bundle runs", async () => {
    const env = await mountFakeSystem();
    try {
      for (const realm of [env.shell, env.first, env.second]) {
        expect(realm.atCreate).toEqual({ net: NET_OPS, socket: SOCKET_OPS });
      }
      expect(env.shell.window.socket).not.toBe(env.first.window.socket);
      expect(env.first.window.socket).not.toBe(env.second.window.socket);
      expect(env.first.window.net).not.toBe(env.second.window.net);

      // Separate handle spaces: each package's first socket is handle 1, and
      // the transport is the System page's WebSocket, not the realm's.
      FakeWebSocket.instances = [];
      expect(env.shell.window.socket.open("ws://shell.test/", OPEN_META)).toBe(1);
      expect(env.first.window.socket.open("ws://first.test/", OPEN_META)).toBe(1);
      expect(env.second.window.socket.open("ws://second.test/", OPEN_META)).toBe(1);
      expect(FakeWebSocket.instances.map((ws) => ws.url)).toEqual([
        "ws://shell.test/",
        "ws://first.test/",
        "ws://second.test/",
      ]);
    } finally {
      env.system.stop();
      env.restore();
    }
  });

  test("socket and net facts become visible only at that package's System tick", async () => {
    const env = await mountFakeSystem();
    try {
      FakeWebSocket.instances = [];
      expect(env.first.window.socket.open("ws://first.test/", OPEN_META)).toBe(1);
      expect(env.first.window.net.start(GET_META("https://api.test/ok"), new ArrayBuffer(0))).toBe(1);
      const [ws] = FakeWebSocket.instances;
      ws.emit("open");
      ws.emit("message", { data: "hello" });
      await Bun.sleep(0);
      await Bun.sleep(0);
      expect(env.fetches.map((entry) => entry.url)).toEqual(["https://api.test/ok"]);

      // Between ticks nothing is guest-visible.
      expect(env.first.window.socket.poll()).toBeUndefined();
      expect(env.first.window.net.poll()).toBeUndefined();

      const before = env.first.frames.length;
      await env.tick();
      expect(env.first.frames.length).toBe(before + 1);
      const frame = env.first.frames[before];
      expect(frame.socket).toEqual([
        { t: "open", h: 1, protocol: "" },
        { t: "message", h: 1, text: true, data: "hello" },
      ]);
      expect(frame.net).toEqual([
        expect.objectContaining({ t: "done", h: 1, status: 200, bytes: 2 }),
      ]);
      // The other packages' frames saw none of it.
      expect(env.second.frames.at(-1)).toEqual({ net: [], socket: [] });
      expect(env.shell.frames.at(-1)).toEqual({ net: [], socket: [] });
    } finally {
      env.system.stop();
      env.restore();
    }
  });

  test("removing an AppInstance closes its sockets and aborts its fetches only", async () => {
    const env = await mountFakeSystem();
    try {
      FakeWebSocket.instances = [];
      env.first.window.socket.open("ws://first.test/", OPEN_META);
      env.second.window.socket.open("ws://second.test/", OPEN_META);
      env.shell.window.socket.open("ws://shell.test/", OPEN_META);
      env.first.window.net.start(GET_META("https://api.test/hang"), new ArrayBuffer(0));
      await Bun.sleep(0);
      const [first, second, shell] = FakeWebSocket.instances;
      const [hanging] = env.fetches;
      expect(hanging.signal.aborted).toBe(false);

      env.bind([2]);
      await env.tick();
      expect(env.first.removed).toBe(true);
      expect(first.closed).toBe(true);
      expect(hanging.signal.aborted).toBe(true);
      expect(second.closed).toBe(false);
      expect(shell.closed).toBe(false);

      env.system.stop();
      expect(second.closed).toBe(true);
      expect(shell.closed).toBe(true);
    } finally {
      env.system.stop();
      env.restore();
    }
  });
});
