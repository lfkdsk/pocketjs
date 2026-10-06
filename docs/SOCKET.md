# SOCKET module

The SOCKET module gives a guest one bounded WebSocket client:

```ts
import { openSocket } from "@pocketjs/framework/socket";

const socket = openSocket("wss://zone.example.com/ws", {
  protocols: ["zone.v1"],
  timeoutMs: 5_000,
});
socket.onOpen = () => socket.send(JSON.stringify({ type: "join" }));
socket.onMessage = (data) => {
  if (typeof data === "string") console.log("text", data);
  else console.log("binary", data.byteLength);
};
socket.onClose = ({ code, reason, clean }) => console.log("closed", code, reason, clean);
```

Messages are whole: text arrives as a `string`, binary as a `Uint8Array`.
There are no streams, extensions (no permessage-deflate), custom request
headers, cookies or server sockets. Plain HTTP requests use the NET module
([NET.md](./NET.md)); the two modules share the host-owned transport rule and
the tick-boundary delivery rule.

## Module ownership

| Layer | Artifact | Owns |
| --- | --- | --- |
| SDK | `framework/src/socket-api.ts` | `openSocket`, `PocketSocket`, `SocketError`, validation, callback dispatch from the service pump |
| Spec | `contracts/spec/socket.ts` | six ops, four event shapes, buffer ownership, limits, close codes, portable errors, tick timing |
| Core | `engine/crates/pocket-socket` | handles, connection states, outbound queue accounting, per-tick event budget, received-message ownership, transport interface |
| Desktop host | `hosts/desktop/src/websocket.rs` | `tungstenite` with rustls on one I/O thread per connection |
| Browser host | `hosts/web/socket.js` | browser `WebSocket` transport with the same state machine and bounds |

## Native transport boundary

`pocket-socket` asks the host for five operations:

```rust
pub trait SocketTransport {
    fn open(&mut self, request: SocketOpen) -> Result<(), SocketFailure>;
    fn send(&mut self, handle: i32, payload: Payload) -> Result<(), SocketFailure>;
    fn close(&mut self, handle: i32, code: u16, reason: String);
    fn take_sent(&mut self, handle: i32) -> Sent;
    fn drain(&mut self, completions: &mut Vec<SocketCompletion>, max: usize);
}

pub struct Sent {
    pub messages: usize, // whole messages written since the previous call
    pub bytes: usize,    // their payload bytes
}
```

`open`, `send` and `close` hand work to a worker or a native async facility
and return without blocking. At a tick boundary the host calls
`SocketSurface::begin_tick`, which asks `take_sent` for each live handle and
releases `bytes + 64 × messages` of queued charge (`Sent::charge`), then
moves at most the remaining per-tick budget of results through `drain`. **A
transport reports whole messages only, and counts each written message once**,
empty messages included: the per-message charge is released by the message
count, not by the byte count. Transport threads never call QuickJS. Results
not drained stay in the transport's queue, which is where inbound
back-pressure starts.

```text
I/O threads read and write independently
        ↓
socket.begin_tick()    credit written messages, admit ≤ 64 results
        ↓
guest.frame(...)       service pump calls socket.poll() once, runs callbacks
```

The service pump is registered while at least one socket is live. An app
without sockets pays one empty-set check per frame and no native call.

## Ops and events

| Op | Code | Signature |
| --- | ---: | --- |
| `open` | 1 | `open(url, metaJson) -> handle \| -1`, meta = `{protocols, timeoutMs}` |
| `send` | 2 | `send(handle, data: ArrayBuffer, isText) -> queuedCharge \| -1` |
| `close` | 3 | `close(handle, code, reason) -> 0 \| -1` |
| `poll` | 4 | `poll() -> JSON array \| undefined` |
| `take` | 5 | `take(messageId, into: ArrayBuffer) -> bytes \| -1` |
| `lastError` | 6 | `lastError() -> "code: message"` |

```text
{"t":"open","h":1,"protocol":"zone.v1"}
{"t":"message","h":1,"text":true,"data":"…"}
{"t":"message","h":1,"text":false,"m":7,"bytes":10}
{"t":"error","h":1,"code":"connect","message":"…"}
{"t":"close","h":1,"code":1000,"reason":"","clean":true}
```

**Every accepted handle ends with exactly one `close` event.** An `error`
event precedes the close when the connection failed. A close without a close
frame from the peer reports code 1006 and `clean: false`. The handle counts
toward the connection limit until `poll()` returns its close event.

**A `close()` before the `open` event aborts the attempt: the handle ends with
`close(1006, clean: false)` and no `error` event, on every host.** Facts the
transport reported for that handle before the abort (an open, messages, a
connect failure) do not reach the guest.

Text messages travel inline in the JSON batch. Binary messages use the
borrow-and-copy rule of the NET module: the event carries a message id and
the exact byte count, the SDK allocates one exactly-sized `ArrayBuffer`, and
`take(m, buffer)` copies into it once. **A binary body not taken is dropped by
the next `poll()`**, so an inattentive guest cannot retain bodies. The SDK
takes every body during dispatch.

## Bounds and back-pressure

| Limit | Value |
| --- | ---: |
| Live connections | 4 |
| URL | 2048 bytes, `ws://` or `wss://`, a host, optional port 1..65535, no userinfo, no fragment, well-formed percent escapes |
| Subprotocol offers | 8 tokens / 512 bytes |
| Message, either direction | 64 KiB |
| Charge per message on top of its payload | 64 bytes |
| Queued outbound charge per connection | 256 KiB |
| Received, undelivered charge per connection | 256 KiB |
| Events admitted per tick, all connections | 64 |
| Opening handshake | 10 s default, 60 s maximum |
| Close reason | 123 bytes |

Every host applies the same URL rule before any transport work and refuses a
violation with `invalid_request`:

- the URL has no whitespace, control bytes or fragment, and every `%` is
  followed by two hex digits (`%G1` and a trailing `%4` are refused);
- the authority has no userinfo and an optional decimal port 1..65535;
- the host is a bracketed RFC 3986 IPv6 literal without a zone id (1–4 hex
  digits per group, at most one `::`, an optional dotted IPv4 tail; `[::1`,
  `[zz]`, `[1::2::3]` and `[1.2.3.4]` are refused), a dotted-decimal IPv4
  address with four parts 0..255 and no leading zeros, or an ASCII reg-name
  without `%`. A reg-name whose last label is all digits or `0x` hex must be
  that IPv4 form, because a browser parses such a host as an IPv4 address
  (`ws://127.1` and `ws://010.0.0.1` are refused).

The rule is stricter than the WHATWG URL parser: every URL it accepts also
parses with `new URL()`. One table, `tests/fixtures/socket-urls.json`, drives
the core, Web host and SDK tests.

**Every message, in either direction, is charged its payload bytes plus 64
bytes.** The overhead bounds the number of queued messages as well as their
bytes: **at most 4096 messages per direction per connection**, empty messages
included.

**Outbound:** `send()` returns the connection's queued charge including the
new message: payload bytes plus 64 per message not yet written. A send that
would exceed 256 KiB of charge is refused with `backpressure`, and
`PocketSocket.send` returns `false` for that refusal; the queue does not grow.
Messages the transport has written are credited back at the next tick
boundary.

**Inbound:** the core admits at most 64 events per tick. On the desktop host
each connection's I/O thread **reads the next message only while a maximal
message (64 KiB plus 64 bytes) still fits in the 256 KiB of undelivered
charge**, so the charge never exceeds 256 KiB and TCP flow control slows the
server. The browser `WebSocket` cannot stop reading; the browser host fails
the connection with `overflow` when a received message would take the
undelivered charge past 256 KiB. A received message over 64 KiB fails the
connection with `message_too_large` and close code 1009.

## Desktop thread model

`hosts/desktop/src/websocket.rs` gives each connection one thread that owns
its socket:

1. **Connect** under one deadline (`timeoutMs`): DNS, TCP connect, TLS (rustls,
   webpki roots) and the HTTP upgrade. **DNS runs on a helper thread and the
   connection stops waiting for it at the deadline**, at a `close()` or at
   host exit. TCP connects on a non-blocking socket that the thread polls
   every 5 ms against the deadline, `close()` and host exit
   (`hosts/desktop/src/dial.rs`). The upgrade response may use at most
   64 KiB including TLS records; a redirect response fails with `handshake`.
   The client sends no `Sec-WebSocket-Extensions` offer and connects without
   a proxy.
2. **Loop:** write queued commands and flush, count the written messages
   and their payload bytes for `take_sent`, then read
   with a 4 ms timeout. The read timeout bounds the latency of a send picked
   up from the command channel. A write blocked for 10 s fails the
   connection.
3. **Close:** a guest `close()` sends the close frame and waits 2 s for the
   peer's reply; without a reply the connection ends with `timeout` and
   close(1006). A peer close frame is echoed and reported with the peer's
   code and reason.

**A `close()` before `open` ends the connection thread within one 5 ms poll
in every phase.** During DNS and TCP connect the thread sees the queued
close; during TLS and the upgrade `close()` also shuts the TCP stream down,
which ends the blocked read or write at once. The guest sees only
`close(1006, clean: false)`.

**Dropping the transport (guest realm teardown or host exit) joins every
connection thread.** Connections not open yet are shut down at once and end
like a `close()`. Open connections get 150 ms to send close code 1001; then
every TCP stream still in use is shut down, which ends blocked reads and
writes. **When the drop returns, every connection's TCP stream is closed**,
at most about 150 ms after the drop started. A DNS lookup still inside the
system resolver (`getaddrinfo`) cannot be interrupted and is abandoned: its
helper thread holds no socket and ends when the resolver returns, which on
glibc is bounded by `timeout` × `attempts` per nameserver in
`/etc/resolv.conf` (5 s × 2 by default). While 8 abandoned lookups are still
running, `open` is refused with `busy`.

The NET transport on the same host (`hosts/desktop/src/fetch.rs`) runs each
request on its own thread over the same dial helper
([NET.md](./NET.md#desktop-transport)). Both
transports are mounted per guest realm by `hosts/desktop/src/network.rs`, for
the shell guest and each System AppInstance.

## Errors

Refusals throw `SocketError` from `openSocket`, `send` and `close` with a
portable `code`: `unavailable`, `invalid_request`, `busy`, `closed`,
`backpressure` (as `false` from `send`), `message_too_large`. Connection
failures arrive as `onError` with `dns`, `connect`, `tls`, `timeout`,
`handshake`, `message_too_large`, `overflow`, `protocol` or `other`, followed
by `onClose`.

## Host status

| Host | Transport | Capability |
| --- | --- | --- |
| desktop (`linux-app`, `macos-app`) | `tungstenite` + rustls, thread per connection | `net.socket` advertised |
| web dev host (`hosts/web/engine.js`) | browser `WebSocket` | mounted as `globalThis.socket` |
| web System host (`web-app`, `hosts/web/system-engine.js`) | the System page's browser `WebSocket`, one `hosts/web/socket.js` host per package Realm; removing an AppInstance closes its sockets | `net.socket` advertised |
| psp, vita, 3ds, pocketbook, other device hosts | not mounted | not advertised; `openSocket` throws `unavailable` |

A manifest that lists `net.socket` under `engine.capabilities.requires` is
refused at plan resolution on every target that does not advertise it. For
PSP and 3DS the planned route to a game server is `io.offload`
([OFFLOAD.md](./OFFLOAD.md)): a paired provider on a PC holds the socket and
the guest exchanges bounded records with it. The provider has no socket relay
yet. Per-host status and limits are listed in [status.md](./status.md).
