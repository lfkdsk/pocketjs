/** Provider-side relay wiring over an authenticated byte channel.
 *
 * The session state machine is shared with the guest
 * (`framework/src/relay/session.ts`); this file only binds a provider
 * machine to a duplex byte transport:
 *
 *   bytes in  -> RelayRecordDecoder (split/coalesced records, bounded)
 *             -> RelaySession.handleRecord
 *   bytes out -> session transport.trySend -> channel.send
 *
 * Authentication and encryption belong to the L0 transport profile
 * (draft §3.2 step 1); `serveRelayTcp` therefore takes an `authenticate`
 * callback that returns the peer identity and grants. The wire layer never
 * trusts identity claims inside HELLO metadata.
 *
 * Each physical connection gets a fresh session machine: reconnect and
 * guest realm reset establish a new session with no carried-over
 * seq/credit/stream state. */

import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { RELAY_LIMITS } from "../contracts/spec/relay.ts";
import { RelayRecordDecoder, type RelayDecodedFrame } from "../framework/src/relay/frame.ts";
import {
  createRelaySession,
  type RelayLocalCapabilities,
  type RelayNegotiation,
  type RelayOpenRequest,
  type RelayPeerContext,
  type RelayPhase,
  type RelaySendStatus,
  type RelaySession,
} from "../framework/src/relay/session.ts";

export type {
  RelayLocalCapabilities,
  RelayNegotiation,
  RelayOpenRequest,
  RelayPeerContext,
  RelayPhase,
  RelaySendStatus,
  RelaySession,
} from "../framework/src/relay/session.ts";
export type { RelayDecodedFrame } from "../framework/src/relay/frame.ts";

/** An authenticated ordered byte channel. `send` is an admission decision:
 * it returns false only when the frame was not taken, so the session may
 * keep its seq and retry later. Returning false after the bytes already
 * entered an underlying queue is wrong — the frame would be delivered and a
 * retry would reuse the seq. A dead channel returns false (or throws). The
 * adapter keeps the underlying socket. */
export interface RelayByteChannel {
  /** Write one whole reassembled record. Returns false when the transport
   * has no queue room right now ("busy") and the frame was not written. */
  send(bytes: Uint8Array): boolean;
  readonly peer: RelayPeerContext;
  onData(callback: (chunk: Uint8Array) => void): void;
  onClose(callback: (reason: string) => void): void;
  destroy(): void;
  readonly closed: boolean;
}

export interface RelayProviderHooks {
  /** Return a RELAY_ERROR code to refuse an OPEN, or null to allow it. */
  authorizeOpen?: (req: RelayOpenRequest, peer: RelayPeerContext) => string | null;
  onPhase?: (phase: RelayPhase, detail?: { reason?: string }) => void;
  onBusinessFrame?: (frame: RelayDecodedFrame) => void;
  onCredit?: (metadata: Record<string, unknown>) => void;
  onReset?: (metadata: Record<string, unknown>) => void;
  onStreamError?: (stream: number, code: string) => void;
  /** A record failed frame-level validation; the connection is dropped. */
  onProtocolError?: (code: string) => void;
}

export interface RelayProviderConnection {
  session: RelaySession;
  peer: RelayPeerContext;
  close(): void;
}

/** Bind one provider session to one authenticated channel. The caller
 * owns accepting the physical connection and authenticating the peer. */
export function attachRelayProvider(options: {
  channel: RelayByteChannel;
  local: RelayLocalCapabilities;
  hooks?: RelayProviderHooks;
}): RelayProviderConnection {
  const { channel, local, hooks } = options;
  // Inbound frames never exceed our own advertised guarantee; min() during
  // negotiation can only shrink it. Size for at least the bootstrap bound.
  const maxWireBytes = Math.max(local.rxLimits.maxWireBytes, RELAY_LIMITS.bootstrapMaxWireBytes);
  const decoder = new RelayRecordDecoder(maxWireBytes);

  const session = createRelaySession({
    role: "provider",
    local,
    transport: {
      peer: channel.peer,
      trySend(bytes): RelaySendStatus {
        if (channel.closed) return "offline";
        return channel.send(bytes) ? "accepted" : "busy";
      },
    },
    authorizeOpen: hooks?.authorizeOpen,
    onPhase: hooks?.onPhase,
    onBusinessFrame: hooks?.onBusinessFrame,
    onCredit: hooks?.onCredit,
    onReset: hooks?.onReset,
    onStreamError: hooks?.onStreamError,
  });

  channel.onData((chunk) => {
    const pushed = decoder.push(chunk);
    if (!pushed.ok) {
      hooks?.onProtocolError?.(pushed.code ?? "RECORD");
      session.handleDisconnect(`record: ${pushed.code ?? "RECORD"}`);
      channel.destroy();
      return;
    }
    for (const record of pushed.frames) session.handleRecord(record);
  });
  channel.onClose((reason) => session.handleDisconnect(reason));

  return {
    session,
    peer: channel.peer,
    close() {
      session.close();
      channel.destroy();
    },
  };
}

// --- guest-side channel binding (the companion is the listener) -------------

/** Bind an existing guest session to a byte channel; used by device-side
 * hosts that dial the companion. `maxWireBytes` is the receiver guarantee
 * the guest advertised in HELLO — the reassembly buffer is one fixed
 * buffer of that size, so a forged length prefix can never drive an
 * allocation. */
export function attachRelayChannel(session: RelaySession, channel: RelayByteChannel, options: {
  maxWireBytes?: number;
} = {}): {
  close(): void;
} {
  const maxWireBytes = Math.max(
    options.maxWireBytes ?? RELAY_LIMITS.controlMaxWireBytes,
    RELAY_LIMITS.bootstrapMaxWireBytes,
  );
  const decoder = new RelayRecordDecoder(maxWireBytes);
  channel.onData((chunk) => {
    const pushed = decoder.push(chunk);
    if (!pushed.ok) {
      session.handleDisconnect(`record: ${pushed.code ?? "RECORD"}`);
      channel.destroy();
      return;
    }
    for (const record of pushed.frames) session.handleRecord(record);
  });
  channel.onClose((reason) => session.handleDisconnect(reason));
  return {
    close() {
      session.close();
      channel.destroy();
    },
  };
}

// --- node:net channel and listener ------------------------------------------

/** Admission check for one frame on a node writable stream.
 *
 * `socket.write()` returning false is backpressure *after* the bytes have
 * entered the stream's queue: the frame will still be flushed, so it cannot
 * be reported as "not admitted" (the session rolls the seq back on busy and
 * a retry puts the same seq on the wire twice). A frame is admitted only
 * when the existing queue plus the frame stays under the high-water mark;
 * with a non-empty queue at the cap the frame is refused before it is
 * written. A frame that alone reaches the mark on an empty queue is still
 * written (the queue drains and later sends return busy until it does). */
export function socketCanAdmit(
  socket: Pick<Socket, "writableLength" | "writableHighWaterMark">,
  bytes: Uint8Array,
): boolean {
  const buffered = socket.writableLength;
  return buffered === 0 || buffered + bytes.length < socket.writableHighWaterMark;
}

/** Adapt a connected (and authenticated) TCP socket to RelayByteChannel. */
export function relaySocketChannel(socket: Socket, peer: RelayPeerContext): RelayByteChannel {
  let closed = socket.destroyed;
  socket.setNoDelay(true);
  const channel: RelayByteChannel = {
    peer,
    get closed() { return closed; },
    send(bytes) {
      if (closed || socket.destroyed || !socket.writable) return false;
      if (!socketCanAdmit(socket, bytes)) return false;
      // The frame is inside the stream's ordered queue now and will be
      // flushed; never relay write()'s post-queue false, which falsely
      // claims the frame was not admitted.
      socket.write(bytes);
      return true;
    },
    onData(callback) {
      socket.on("data", (chunk: Buffer) => callback(chunk));
    },
    onClose(callback) {
      socket.once("close", () => callback(closed ? "closed" : "peer closed"));
      socket.on("error", (error) => {
        closed = true;
        callback((error as NodeJS.ErrnoException).code ?? "socket error");
      });
    },
    destroy() {
      closed = true;
      socket.destroy();
    },
  };
  socket.on("close", () => { closed = true; });
  return channel;
}

export interface RelayTcpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Listen for authenticated relay connections. `authenticate` runs before
 * any session state exists and returns the peer grants, or null to reject
 * the connection. Every accepted socket gets its own provider session. */
export function serveRelayTcp(options: {
  port?: number;
  host?: string;
  local: RelayLocalCapabilities;
  authenticate: (socket: Socket) => RelayPeerContext | null | Promise<RelayPeerContext | null>;
  hooks?: RelayProviderHooks | ((peer: RelayPeerContext) => RelayProviderHooks);
  onConnection?: (connection: RelayProviderConnection) => void;
}): Promise<RelayTcpServer> {
  const server = createServer((socket) => {
    void (async () => {
      let peer: RelayPeerContext | null = null;
      try {
        peer = await options.authenticate(socket);
      } catch {
        peer = null;
      }
      if (!peer) { socket.destroy(); return; }
      const hooks = typeof options.hooks === "function" ? options.hooks(peer) : options.hooks;
      const channel = relaySocketChannel(socket, peer);
      const connection = attachRelayProvider({ channel, local: options.local, hooks });
      options.onConnection?.(connection);
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("relay tcp listen failed"));
        return;
      }
      resolve({
        server,
        port: address.port,
        close: () => new Promise<void>((done) => { server.close(() => done()); }),
      });
    });
  });
}

/** The negotiated parameters once a connection reaches READY. */
export async function relayReady(session: RelaySession): Promise<RelayNegotiation> {
  return session.whenReady();
}
