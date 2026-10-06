// PocketJS socket spec — the boundary of the SOCKET module
// (`globalThis.socket`).
//
// This module exposes one bounded WebSocket client primitive. The public SDK
// is `openSocket()`; the native boundary below stays small so a desktop
// thread (tungstenite), a browser `WebSocket`, or a device stack can carry it
// without reproducing the WHATWG WebSocket object.
//
// The four parts of the boundary (the same shape as contracts/spec/net.ts):
//
//   ops            guest -> core intent (numeric codes below, append-only)
//   events         core -> guest facts (one JSON batch per tick)
//   data contract  open metadata JSON + borrowed send buffer + taken message
//   frame contract transport never enters QuickJS; transport results become
//                  visible only at a host tick boundary, at most
//                  SOCKET_MAX_EVENTS_PER_TICK per tick, and SDK callbacks run
//                  inside that guest turn's service pump
//
// Ownership:
//   send() BORROWS the payload ArrayBuffer for the synchronous call. The host
//   copies it before returning. take() BORROWS an exactly-sized destination,
//   copies one received binary message into it, and succeeds at most once.
//   Untaken binary messages are discarded by the next poll().
//
// Back-pressure:
//   Every message, in either direction, is charged its payload bytes plus
//   SOCKET_MESSAGE_OVERHEAD_BYTES, so empty messages are bounded by the same
//   budgets as payload.
//   Outbound: each connection has SOCKET_MAX_SEND_QUEUE_BYTES of queued,
//   not-yet-written charge. send() beyond it is refused with `backpressure`
//   instead of growing the queue; written messages are credited back at a
//   tick boundary.
//   Inbound: the core admits at most SOCKET_MAX_EVENTS_PER_TICK events per
//   tick. A transport holds at most SOCKET_MAX_RECV_QUEUE_BYTES of received,
//   undelivered charge per connection and stops reading (TCP back-pressure)
//   or fails the connection with `overflow` when it cannot stop the peer.
//
// If you change ANY value here: run `bun contracts/spec/gen-rust.ts`, commit
// the regenerated engine/core/src/spec.rs (tests/contract.ts byte-compares).

// ---------------------------------------------------------------------------
// Socket ops (the `socket.*` native contract)
// ---------------------------------------------------------------------------
//
// Signatures (authoritative; hosts marshal them however they like):
//   open(url:string, metaJson:string) -> handle | -1
//      url = absolute ws:// or wss:// URL without a fragment or userinfo;
//      every `%` is followed by two hex digits. The authority is a host and
//      an optional decimal port 1..65535. The host is a bracketed RFC 3986
//      IPv6 literal without a zone id, a dotted-decimal IPv4 address (four
//      parts 0..255, no leading zeros), or an ASCII reg-name without `%`
//      whose last label is neither all digits nor 0x-hex (WHATWG URL parses
//      such a host as IPv4).
//      metaJson = {protocols, timeoutMs}; timeoutMs bounds connect + TLS +
//      opening handshake. Accepted or refused synchronously; read lastError()
//      on -1. An accepted handle reports `open` or `close` through poll().
//   send(handle, data:ArrayBuffer, isText:boolean) -> queuedBytes | -1
//      Queue one whole message. Text payloads are UTF-8 bytes. Returns the
//      connection's queued outbound charge (payload bytes plus
//      SOCKET_MESSAGE_OVERHEAD_BYTES per message) including this message.
//   close(handle, code, reason) -> 0 | -1
//      Start the closing handshake. code is 1000 or 3000..4999; reason is at
//      most SOCKET_MAX_CLOSE_REASON_BYTES of UTF-8. The handle still ends with
//      exactly one `close` event. A close() before the `open` event aborts
//      the attempt: the handle ends with close(1006, clean=false) and no
//      `error` event, on every host.
//   poll() -> string | undefined
//      Drain the ENTIRE event batch visible at this tick as one JSON array.
//      The SDK calls this once per tick only while sockets are live.
//   take(messageId, into:ArrayBuffer) -> bytesCopied | -1
//      Copy one binary message body exactly once. `into.byteLength` must
//      equal the `bytes` field of its message event.
//   lastError() -> string
//      Portable `code: message` for the most recent synchronous refusal.

export const SOCKET_OP = {
  open: 1,
  send: 2,
  close: 3,
  poll: 4,
  take: 5,
  lastError: 6,
} as const;

// ---------------------------------------------------------------------------
// Events (core -> guest facts; all events for a tick in one JSON array)
// ---------------------------------------------------------------------------
//
//   {"t":"open","h":n,"protocol":""}
//   {"t":"message","h":n,"text":true,"data":"…"}
//   {"t":"message","h":n,"text":false,"m":id,"bytes":n}
//   {"t":"error","h":n,"code":"connect","message":"…"}
//   {"t":"close","h":n,"code":1000,"reason":"","clean":true}
//
// Events of one handle keep transport order. Every accepted handle produces
// exactly one terminal `close` event; `error` is informational and always
// precedes that close. A close without a received close frame reports code
// 1006 and clean=false. The handle number is free for reuse after its close
// event has been polled.

export const SOCKET_EVENT = {
  open: "open",
  message: "message",
  error: "error",
  close: "close",
} as const;

/** Close codes the module itself reports. A guest may send 1000 or a code in
 * the application range 3000..4999. */
export const SOCKET_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  abnormal: 1006,
  invalidPayload: 1007,
  messageTooBig: 1009,
} as const;

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Live handles, including handles whose close event is not yet polled. */
export const SOCKET_MAX_CONNECTIONS = 4;

export const SOCKET_MAX_URL_BYTES = 2048;

/** Sec-WebSocket-Protocol offers: count and summed UTF-8 bytes. */
export const SOCKET_MAX_PROTOCOLS = 8;
export const SOCKET_MAX_PROTOCOL_BYTES = 512;

/** One whole message, either direction. A larger inbound message fails the
 * connection with close code 1009 and error `message_too_large`. */
export const SOCKET_MAX_MESSAGE_BYTES = 64 * 1024;

/** Outbound charge queued per connection before send() reports backpressure. */
export const SOCKET_MAX_SEND_QUEUE_BYTES = 256 * 1024;

/** Received, undelivered charge a transport holds per connection. */
export const SOCKET_MAX_RECV_QUEUE_BYTES = 256 * 1024;

/** Queue charge of one message on top of its payload bytes. Bounds the
 * number of queued messages (4096 per direction per connection) as well as
 * their bytes. */
export const SOCKET_MESSAGE_OVERHEAD_BYTES = 64;

/** Events admitted into one tick batch across all connections. */
export const SOCKET_MAX_EVENTS_PER_TICK = 64;

/** Opening handshake (connect + TLS + HTTP upgrade) timeout. */
export const SOCKET_DEFAULT_TIMEOUT_MS = 10_000;
export const SOCKET_MAX_TIMEOUT_MS = 60_000;

/** RFC 6455 control frames carry at most 125 bytes: 2 code + 123 reason. */
export const SOCKET_MAX_CLOSE_REASON_BYTES = 123;

/** Portable errors. A transport maps platform/library failures into these
 * codes before crossing the module boundary. */
export const SOCKET_ERROR = {
  unavailable: "unavailable",
  invalidRequest: "invalid_request",
  busy: "busy",
  closed: "closed",
  backpressure: "backpressure",
  dns: "dns",
  connect: "connect",
  tls: "tls",
  timeout: "timeout",
  handshake: "handshake",
  messageTooLarge: "message_too_large",
  overflow: "overflow",
  protocol: "protocol",
  other: "other",
} as const;

export type SocketErrorCode = (typeof SOCKET_ERROR)[keyof typeof SOCKET_ERROR];
