# NET module

The NET module gives a guest one bounded HTTP client API:

```ts
import { fetch } from "@pocketjs/framework/net";

const response = await fetch("https://api.example.com/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Pocket" }),
  timeoutMs: 5_000,
  maxBytes: 64 * 1024,
});

if (!response.ok) throw new Error(`HTTP ${response.status}`);
const value = await response.json();
```

This is fetch-shaped, not the complete browser Fetch standard. V1 includes
`fetch`, common application methods, string/byte request bodies, headers,
timeouts, a response-size limit, and buffered `text()`, `json()`, `bytes()`
and `arrayBuffer()` reads. It does not include `Request`, `Headers`, streams,
cookies, cache, proxy configuration, `AbortSignal`, servers, or raw sockets.
WebSocket clients are the separate SOCKET module ([SOCKET.md](./SOCKET.md)).

## Module ownership

| Layer | Upstream artifact | Owns |
| --- | --- | --- |
| SDK | `framework/src/net-api.ts` | `fetch`, `PocketResponse`, validation, lazy Promise delivery |
| Spec | `contracts/spec/net.ts` | five ops, two event shapes, buffer ownership, limits, portable errors, tick timing |
| Core | `engine/crates/pocket-net` | handles, request lifecycle, limits, event batches, completed bodies, transport interface |
| Deterministic host | `hosts/sim/net.ts` | fixture routes and virtual-tick completions for conformance tests |
| Browser host | `hosts/web/net.js` | browser `fetch` transport, bounded streaming read, redirects, tick staging |
| Desktop host | `hosts/desktop/src/fetch.rs` | HTTP/1.1 client + rustls on one worker thread per request, same-scheme redirects, bounded body read, cancellable connect and I/O |

The physical HTTP implementation belongs to the host that owns the network
resource. PocketJS does not choose one transport library for every runtime.
A desktop runtime can adapt a blocking HTTP client, an ESP runtime can adapt
`esp_http_client`, and an Apple host can adapt `URLSession`; none of those
libraries become part of the guest contract or the transport-neutral core.

A product runtime outside this repository keeps its adapter in that runtime's
repository. An adapter belongs under `hosts/<host>/` here only when PocketJS
itself owns and tests that host. The framework SDK, canonical spec, reference
core, and deterministic sim stay upstream because every host must agree on
them.

## Native transport boundary

`pocket-net` asks the host for only three operations:

```rust
pub trait HttpTransport {
    fn start(&mut self, request: HttpRequest) -> Result<(), NetFailure>;
    fn cancel(&mut self, handle: i32);
    fn drain(&mut self, completions: &mut Vec<TransportCompletion>);
}
```

`start` hands an owned request to a worker or native async facility and must
return promptly. `drain` is non-blocking and is called by the host once at a
tick boundary. Network threads never call QuickJS. The reference core turns
drained completions into one JSON event batch; the guest consumes that batch
during its next normal turn.

`NetSurface` — the one-line `globalThis.net` install on `pocket-mod` hosts —
is the crate's `mount` feature (default). A host with its own QuickJS wiring
depends with `default-features = false` and drives `NetCore` directly, so the
MCU build never compiles an engine it doesn't use (the `pocket-fs` pattern).

For a runtime using `NetSurface<T>`, the host loop is:

```text
transport threads work independently
        ↓
net.begin_tick()       drain completed transport work
        ↓
guest.frame(...)       framework service pump calls net.poll() if needed
        ↓
guest job drain        fetch Promise reactions run
```

There is no idle native polling. The framework service-pump set is normally
empty. The first pending `fetch` registers the NET pump; the final completion
removes it. While requests are pending there is one `poll()` FFI call per
guest tick, and that call drains the whole visible batch rather than one event
per crossing.

## Bounded whole responses

V1 resolves `fetch` only after the response body is complete. The transport
still reads incrementally and must stop as soon as `maxBytes` is exceeded;
the reference core checks the final size again before making it visible.
Consequently a slow or large response does not block the guest and cannot
grow without bound, but V1 is not suitable for media downloads or other
payloads that fundamentally require streaming.

| Limit | V1 value |
| --- | ---: |
| Concurrent requests | 2 |
| Request body | 64 KiB |
| Response body default | 128 KiB |
| Response body absolute maximum | 256 KiB |
| Headers | 32 fields / 8 KiB |
| Timeout | 30 s default / 120 s maximum |
| Redirects | 3, same scheme as the request URL |
| URL | 2048 bytes |

Two concurrent requests bound TLS buffers, worker state, and completed-body
memory while covering the usual foreground request plus asset/config request.
The response cap is selected per call so a small JSON endpoint can use a much
tighter budget than the global ceiling.

## Method set

V1 accepts `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`.
These are the common application methods that portable embedded HTTP clients
can express. `CONNECT` creates a tunnel and `TRACE` has distinct security and
proxy semantics, so neither belongs in an app-level fetch module. Arbitrary
extension methods can be added later only when more than one real host needs
them; keeping a closed set today lets every target make the same promise.

## Body ownership

The request body is borrowed only for the synchronous `net.start` call and is
copied into host-owned memory before that call returns. A done event includes
the exact response byte count. The guest allocates one exactly-sized
`ArrayBuffer`, then `net.take(handle, buffer)` copies into it and deletes the
core's copy. This makes ownership explicit and keeps the ABI independent of a
specific QuickJS wrapper's object-lifetime rules.

## Errors and HTTP status

Transport failures reject with `NetError` and a portable `code` such as
`dns`, `connect`, `tls`, `timeout`, `redirect`, or `response_too_large`.
An HTTP 404 or 500 is a successful HTTP exchange: `fetch` resolves,
`response.status` carries the code, and `response.ok` is false. This preserves
the useful part of browser fetch behavior without importing its larger object
model.

## Redirects

Transports follow at most three redirects and refuse a hop that changes the
scheme (`https://` to `http://` or the reverse) with code `redirect`. A 303,
or a 301/302 answering a `POST`, continues as a bodiless `GET`; 307 and 308
repeat the method and body. The desktop transport drops `authorization`,
`cookie` and `proxy-authorization` headers when a hop changes origin.

**Every redirect target and the final response URL stay within the 2048-byte
URL bound**; a longer one fails the request with `redirect` on the desktop and
browser hosts. The browser host requests with `redirect: "manual"`. **Inside a
browser page that mode returns an opaque redirect without `Location`, so every
3xx answer rejects with `redirect`**; the hop-following path runs where the
platform `fetch` exposes `Location`, as Bun's does.

## Host status

| Host | Transport | Capability |
| --- | --- | --- |
| desktop (`linux-app`, `macos-app`) | `hosts/desktop/src/fetch.rs`: HTTP/1.1 client with rustls (ring, webpki roots), one thread per request, at most 8 worker threads including cancelled requests still ending and abandoned DNS lookups | `net.http` advertised |
| web dev host | `hosts/web/net.js`: browser `fetch` with `credentials: "omit"` and manual redirects | mounted as `globalThis.net` |
| web System host (`web-app`) | `hosts/web/system-engine.js`: one `hosts/web/net.js` host per package Realm over the System page's `fetch`; removing an AppInstance aborts its requests | `net.http` advertised |
| sim | `hosts/sim/net.ts`: fixture routes, virtual-tick completions | deterministic tests |
| psp, vita, 3ds, pocketbook, other device hosts | not mounted | not advertised; `fetch` rejects with `unavailable` |

Browser hosts are subject to the page's CORS and mixed-content rules: a
cross-origin endpoint must answer with CORS headers, and an `https://` page
cannot fetch `http://` URLs. Per-host status and limits are listed in
[status.md](./status.md).

## Desktop transport

`hosts/desktop/src/fetch.rs` runs each request on one worker thread with a
small HTTP/1.1 client and rustls (ring, bundled webpki roots; the OS trust
store is not read), without a proxy. Each hop is one `connection: close`
exchange; the body is framed by `content-length`, `chunked` (trailers are
discarded) or the end of the stream, and interim 1xx responses are skipped.
The client writes `host`, `connection`, `content-length` and
`transfer-encoding` itself and ignores guest values for them; it sends
`accept: */*` and `user-agent: PocketJS` unless the guest sets those. Bodies
are not decompressed and no `accept-encoding` is sent. **One deadline
(`timeoutMs`) covers DNS, every redirect hop and the body read.**

DNS runs on a helper thread and TCP connects on a non-blocking socket; the
worker polls both every 5 ms against the deadline and the request's cancel
flag (`hosts/desktop/src/dial.rs`). **`cancel()` and transport drop set that
flag and shut the request's TCP stream down**, which ends a blocked TLS
handshake, write or body read at once. `cancel()` removes the request from the
core at once and discards its late result. **At most 8 worker threads are
alive, including cancelled requests still ending and abandoned DNS
lookups**; `start` beyond that is refused with `busy`.

**Dropping the transport (guest realm teardown or host exit) joins every
worker**, so every request's TCP stream is closed when the drop returns,
within a few milliseconds of the drop starting. A DNS lookup still inside the
system resolver (`getaddrinfo`) cannot be interrupted and is abandoned: its
helper thread holds no socket and ends when the resolver returns, which on
glibc is bounded by `timeout` × `attempts` per nameserver in
`/etc/resolv.conf` (5 s × 2 by default).
