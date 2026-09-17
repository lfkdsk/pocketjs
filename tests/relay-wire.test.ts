import { expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import {
  attachRelayProvider,
  relaySocketChannel,
  serveRelayTcp,
} from "../tools/relay-wire.ts";
import {
  createRelaySession,
  type RelayTransportAdapter,
} from "../framework/src/relay/session.ts";
import { RelayRecordDecoder } from "../framework/src/relay/frame.ts";
import { RELAY_LIMITS, type RelayProtocolVersion, type RelayRxLimits } from "../contracts/spec/relay.ts";

const RX: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144,
};
const local = {
  versions: [[1, 0] as RelayProtocolVersion],
  profiles: [{ name: "map.raster", version: 1 }],
  codecs: [0, 1, 257],
  kinds: [1, 6],
  rxLimits: RX,
};

test("relay-wire: a provider over TCP completes the six-step handshake and an OPEN", async () => {
  const reached: string[] = [];
  const server = await serveRelayTcp({
    local: { ...local },
    authenticate: () => ({ id: "device-1", grants: ["pocket-map"] }),
    hooks: (peer) => ({
      onPhase: (phase) => reached.push(`${peer.id}:${phase}`),
    }),
  });

  // Guest side: raw socket + shared session machine.
  const socket = connect(server.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const guestAdapter: RelayTransportAdapter = {
    peer: { id: "companion", grants: ["pocket-map"] },
    trySend: (bytes) => (socket.write(bytes) ? "accepted" : "busy"),
  };
  const guest = createRelaySession({
    role: "guest",
    transport: guestAdapter,
    local: { app: "pocket-map", ...local },
    pingIntervalMs: 10 ** 9, // keep this test free of ping frames
    stallMs: 10 ** 9,
  });
  const decoder = new RelayRecordDecoder(RELAY_LIMITS.bootstrapMaxWireBytes);
  socket.on("data", (rawChunk) => {
    const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
    const pushed = decoder.push(chunk);
    if (!pushed.ok) throw new Error(pushed.code);
    for (const record of pushed.frames) guest.handleRecord(record);
  });

  const ready = guest.whenReady();
  expect(guest.hello().ok).toBe(true);
  await ready;
  expect(guest.phase).toBe("ready");
  expect(guest.negotiation?.version).toEqual([1, 0]);

  const opened = await guest.open({
    app: "pocket-map", namespace: "map/demo",
    profile: { name: "map.raster", version: 1 },
  });
  expect(opened.stream).toBe(1);
  expect(opened.namespace).toBe("map/demo");
  expect(reached).toContain("device-1:ready");

  guest.close();
  socket.destroy();
  await server.close();
});

test("relay-wire: authenticate() returning null destroys the socket before any HELLO", async () => {
  let connections = 0;
  const server = await serveRelayTcp({
    local: { ...local },
    authenticate: () => null,
    onConnection: () => { connections++; },
  });
  const socket = connect(server.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("close", resolve));
  socket.destroy();
  await server.close();
  expect(connections).toBe(0);
});

test("relay-wire: attachRelayProvider tears down on a malformed (oversized) record", async () => {
  // In-memory channel pair; no TCP needed.
  const server = createServer();
  const protocolErrors: string[] = [];
  let serverSocket: Socket | undefined;
  const accepted = new Promise<void>((resolve) => {
    server.once("connection", (s) => { serverSocket = s; resolve(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");

  const client = connect(address.port, "127.0.0.1");
  await new Promise<void>((resolve) => client.once("connect", resolve));
  await accepted;

  const connection = attachRelayProvider({
    channel: relaySocketChannel(serverSocket!, { id: "d", grants: ["pocket-map"] }),
    local: { ...local },
    hooks: { onProtocolError: (code) => protocolErrors.push(code) },
  });
  // Forged length prefix far over the 4096 cap.
  const forged = Buffer.alloc(8);
  forged.writeUInt32LE(0x00100000, 0);
  client.write(forged);
  await new Promise<void>((resolve) => client.once("close", resolve));
  expect(protocolErrors).toEqual(["WIRE_TOO_LARGE"]);
  // No HELLO ever ran, so the disconnect leaves the machine at idle.
  expect(connection.session.phase).toBe("idle");
  client.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("relay-wire: a PING sent over the real socket is answered", async () => {
  const server = await serveRelayTcp({
    local: { ...local },
    authenticate: () => ({ id: "device-1", grants: ["pocket-map"] }),
  });
  const socket = connect(server.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));

  // Large ping interval so the machine does not ping first; drive one ping
  // manually through a tiny wrapper clock is unnecessary — use the public
  // stats: after READY, schedule a ping via a near-zero interval instead.
  const guestAdapter: RelayTransportAdapter = {
    peer: { id: "companion", grants: ["pocket-map"] },
    trySend: (bytes) => (socket.write(bytes) ? "accepted" : "busy"),
  };
  const guest = createRelaySession({
    role: "guest",
    transport: guestAdapter,
    local: { app: "pocket-map", ...local },
    pingIntervalMs: 5,
    stallMs: 10 ** 9,
  });
  const decoder = new RelayRecordDecoder(RELAY_LIMITS.bootstrapMaxWireBytes);
  socket.on("data", (rawChunk) => {
    const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
    const pushed = decoder.push(chunk);
    if (!pushed.ok) throw new Error(pushed.code);
    for (const record of pushed.frames) guest.handleRecord(record);
  });
  guest.hello();
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no pong")), 3000);
    const check = () => {
      if (guest.getStats().pingsReceived > 0) { clearTimeout(t); resolve(); }
      else setTimeout(check, 10);
    };
    setTimeout(check, 10);
  });
  expect(guest.getStats().pingsReceived).toBeGreaterThan(0);
  guest.close();
  socket.destroy();
  await server.close();
  expect(guest.getStats().pingsReceived).toBeGreaterThan(0);
});
