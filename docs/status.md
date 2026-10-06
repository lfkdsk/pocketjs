# Feature status

This page records which PocketJS features each host delivers today. The
capability registry in `contracts/spec/platforms.ts` is the authority for what
a target advertises; this page adds the limits and the test that covers each
item. Each domain has its own section.

| Mark | Meaning |
| --- | --- |
| **Done** | Implemented, mounted by the named host and covered by the referenced tests |
| **Partial** | Usable, with a named piece missing |
| **Planned** | Not implemented; the capability is absent on that target |

## Networking

A target that does not advertise `net.http` or `net.socket` refuses a manifest
that lists the id under `engine.capabilities.requires` at plan resolution. At
run time, where the namespace is not mounted, `fetch` rejects and `openSocket`
throws with code `unavailable`.

### HTTP fetch (`net.http`)

| Item | Status | What works now, and its limits | Reference |
| --- | --- | --- | --- |
| Contract, SDK and core (`@pocketjs/framework/net`, `engine/crates/pocket-net`, sim host) | **Done** | Whole-response `fetch` with **2 concurrent requests, 64 KiB request body, 256 KiB maximum response, 3 same-scheme redirects and 2048-byte URLs**, settled at a tick boundary; no streams, cookies, cache, `AbortSignal` or proxy configuration. | [NET.md](./NET.md), `tests/net.test.ts` |
| Web dev host (`hosts/web/engine.js`) | **Done** | Browser `fetch` with `credentials: "omit"` and `cache: "no-store"`. Requests are subject to the browser's CORS and mixed-content rules, and **in a browser every 3xx answer rejects with `redirect`**, because `redirect: "manual"` returns an opaque redirect without `Location`. | [NET.md](./NET.md#host-status), `tests/net-web.test.js` |
| Web System host (`web-app`, `hosts/web/system-engine.js`) | **Done** | One NET host per package Realm, ticked before that package's frame; **each package has its own 2-request limit** and removing an AppInstance aborts its requests. Same browser rules as the dev host. Covered with a scripted `fetch`, not a browser end-to-end run. | [BACKENDS.md](./BACKENDS.md#browser-system-host), `tests/web-system-host.test.ts` |
| Desktop (`linux-app`, `macos-app`) | **Done** | HTTP/1.1 client with rustls and the bundled webpki roots (the OS trust store is not read), one worker thread per request and **at most 8 worker threads**, DNS bounded by the request deadline, no proxy, no compression. **`cancel()`, removing the realm or exiting ends the request within a few milliseconds in every phase** (connect, TLS, write, body read); a DNS lookup inside the system resolver is abandoned and ends when the resolver returns. | [NET.md](./NET.md#desktop-transport), `hosts/desktop/src/network_tests.rs`, `tests/desktop-net.test.ts` |
| PS Vita (`vita`) | **Planned** | The `vita` profile does not advertise `net.http` and the host mounts no NET module. The Vita's WiFi stack carries the svc companion connection only. | `contracts/spec/platforms.ts` |
| PSP, 3DS, PocketBook, other device hosts | **Planned** | No profile advertises `net.http`; no transport is mounted. | `contracts/spec/platforms.ts` |

### WebSocket (`net.socket`)

| Item | Status | What works now, and its limits | Reference |
| --- | --- | --- | --- |
| Contract, SDK and core (`@pocketjs/framework/socket`, `engine/crates/pocket-socket`) | **Done** | `openSocket` with whole text and binary messages, **4 live connections, 64 KiB messages, 256 KiB send and receive charge per connection with 64 bytes of overhead per message, 64 events per tick**; no streams, extensions, custom headers, cookies or server sockets. **Every host checks URLs with one rule before any transport work** (IPv6 and IPv4 literals parsed, percent escapes well-formed, one shared test table). There is no deterministic sim host; tests drive the browser host. | [SOCKET.md](./SOCKET.md), `tests/socket.test.ts` |
| Desktop (`linux-app`, `macos-app`) | **Done** | `tungstenite` with rustls and the bundled webpki roots, one I/O thread per connection, ws:// and wss://, **reading pauses while a 64 KiB message would no longer fit in the 256 KiB received charge**, so TCP flow control slows the peer. No permessage-deflate offer and no proxy. **`close()` before open ends the attempt within a few milliseconds in every phase (DNS, TCP connect, TLS, upgrade); teardown gives open connections 150 ms to send 1001**, and abandons a DNS lookup inside the system resolver. | [SOCKET.md](./SOCKET.md#desktop-thread-model), `hosts/desktop/src/network_tests.rs`, `tests/desktop-net.test.ts` |
| Web dev host (`hosts/web/engine.js`) | **Done** | Browser `WebSocket`. The browser cannot stop reading, so **more than 256 KiB of undelivered charge fails the connection with `overflow`**; the browser may negotiate permessage-deflate on its own. | [SOCKET.md](./SOCKET.md#host-status), `tests/socket-web.test.ts` |
| Web System host (`web-app`, `hosts/web/system-engine.js`) | **Done** | One SOCKET host per package Realm with **its own 4-connection limit**; removing an AppInstance closes its sockets. Covered with a scripted `WebSocket`, not a browser end-to-end run. | [BACKENDS.md](./BACKENDS.md#browser-system-host), `tests/web-system-host.test.ts` |
| PSP, 3DS | **Planned** | The capability is absent: the profiles advertise `io.offload` and not `net.socket`. The plan routes game traffic through `io.offload` to a paired provider on a PC that holds the socket; no socket relay exists in the provider yet. | [OFFLOAD.md](./OFFLOAD.md) |
| PS Vita (`vita`) | **Planned** | The `vita` profile advertises neither `net.socket` nor `io.offload`; `openSocket` throws `unavailable`. | `contracts/spec/platforms.ts` |

## Desktop host

| Item | Status | What works now, and its limits | Reference |
| --- | --- | --- | --- |
| `--headless` runs | **Done** | Runs the 60 Hz tick loop on the main thread without a window, with scripted input (`--key`, `--mouse`, `--click`, `--type`), `--quit-after N` and `--trace-frames`. `--screenshot PATH` writes the final frame only and needs a wgpu adapter for its offscreen device. | `hosts/desktop/src/headless.rs`, `tests/desktop-net.test.ts` |

## Examples

| Item | Status | What works now, and its limits | Reference |
| --- | --- | --- | --- |
| `apps/socket-zone` | **Partial** | A zone-server client: joins, sends the held d-pad at 20 Hz over binary messages and draws the players the server reports. The zone server is not part of this repository. Desktop builds connect to **`ws://127.0.0.1:8080/ws`**; the web dev host reads the URL from the `zone` query parameter. | `apps/socket-zone/app.tsx`, [SOCKET.md](./SOCKET.md) |
