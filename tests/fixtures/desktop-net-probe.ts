// Guest bundle for tests/desktop-net.test.ts: drives the fetch and socket
// SDKs inside the desktop host's QuickJS realm and logs `PROBE <json>` lines.
// __PROBE_ORIGIN__ (host:port of the test's Bun server) is defined at build.
import { fetch } from "../../framework/src/net-api.ts";
import { openSocket } from "../../framework/src/socket-api.ts";
import { runServicePumps } from "../../framework/src/services.ts";

declare const __PROBE_ORIGIN__: string;

const log = (value: unknown) => console.log(`PROBE ${JSON.stringify(value)}`);
const http = `http://${__PROBE_ORIGIN__}`;
let tick = 0;

function settle(name: string, promise: Promise<unknown>): void {
  promise.then(
    (value) => log({ name, ok: true, value, tick }),
    (error) => log({ name, ok: false, code: (error as { code?: string }).code, tick }),
  );
}

// NET_MAX_INFLIGHT is 2: a third concurrent request is refused with `busy`;
// the second pair starts once the first has settled.
const first = [
  fetch(`${http}/hello`).then(async (r) => ({ status: r.status, header: r.headers["x-bun"], text: await r.text() })),
  fetch(`${http}/redirect`).then(async (r) => ({ url: r.url, text: await r.text() })),
];
settle("get", first[0]);
settle("redirect", first[1]);
settle("busy", fetch(`${http}/hello`));
Promise.allSettled(first).then(() => {
  settle("scheme", fetch(`${http}/scheme`));
  settle("post", fetch(`${http}/echo`, { method: "POST", body: new Uint8Array([1, 2, 3]) }).then(async (r) => Array.from(await r.bytes())));
});

const socket = openSocket(`ws://${__PROBE_ORIGIN__}/ws`, { protocols: ["probe.v1"] });
socket.onOpen = () => {
  log({ name: "open", protocol: socket.protocol, tick });
  socket.send("hello");
  socket.send(new Uint8Array([9, 8, 7]));
  socket.send("close-me");
};
socket.onMessage = (data) =>
  log({ name: "message", data: typeof data === "string" ? data : Array.from(data), tick });
socket.onClose = (event) => log({ name: "close", ...event, tick });

(globalThis as { frame?: (buttons: number) => void }).frame = () => {
  tick++;
  runServicePumps();
};
