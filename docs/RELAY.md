# Relay

Relay is the L1 session/frame and L2 resource/delivery contract shared by a
PocketJS guest and a paired companion. **It does not replace the existing
`io.offload` record format; a v1 peer is reached through explicit capability
negotiation, never by probing an existing connection.** The single source of
truth is `contracts/spec/relay.ts`. The TS codec is
`framework/src/relay/frame.ts`; the C and Rust frame layers consume the same
byte vectors under `tests/fixtures/relay/`. Every encoding value in this
document is the R5 proposal (`R5-P03` and following in the relay design
draft), not an existing PocketJS ABI.

## Fixed frame

**Every record is a 4-byte little-endian length prefix followed by a 48-byte
fixed header, one strict UTF-8 JSON metadata object, and raw data bytes.** All
integers are little-endian. `session` is a u64 and is held as a JS bigint; it
never crosses `Number`.

`frameBytes` does not count the 4-byte prefix. The length identity checked by
every receiver is:

```
frameBytes + 4 == 48 + metaBytes + dataBytes
```

| Offset | Field | Width | Rule |
| --- | --- | --- | --- |
| 0 | `frameBytes` | u32 | `44 + metaBytes + dataBytes`; validated before payload is trusted |
| 4 | `magic` | 4B | ASCII `PRLY` |
| 8 | `major` | u8 | `1` |
| 9 | `minor` | u8 | `0` in v1; selected exactly during READY |
| 10 | `type` | u8 | `1..5`, see below |
| 11 | `flags` | u8 | must be `0`; a nonzero reserved bit rejects the frame |
| 12 | `headerBytes` | u16 | must be `48` including the prefix |
| 14 | `codec` | u16 | `0` = no data; otherwise the negotiated data codec |
| 16 | `session` | u64 | nonzero after HELLO; `0` only on the bootstrap exchange |
| 24 | `seq` | u32 | starts at 1 per `(session, stream, direction)`; never wraps |
| 28 | `stream` | u32 | `0` is the control stream |
| 32 | `correlation` | u32 | request id; `>0` for REQUEST/RESPONSE/CANCEL, `0` for PUSH/INVALIDATE |
| 36 | `metaBytes` | u32 | byte length of the metadata object; no BOM or trailing LF |
| 40 | `dataBytes` | u32 | raw bytes following metadata; no padding |
| 44 | `reserved` | u32 | must be `0` |
| 48 | `metadata` | `metaBytes` | strict UTF-8 JSON object |
| 48+metaBytes | `data` | `dataBytes` | encoding selected by `codec` |

TCP input may arrive split or coalesced. `RelayRecordDecoder` keeps one fixed
assembly buffer of `maxWireBytes + 4` and validates the declared length
against that cap before more bytes accumulate, so a forged prefix cannot
drive an allocation. A missing, duplicate, or reordered `seq` stops that
stream and triggers resync; an error on stream 0 ends the session.

## Metadata

**Metadata is JSON encoded once per frame. Binary stays in the data region;
it is never base64-wrapped into metadata.** v1 metadata rules: root is an
object; duplicate keys reject; no NaN or Infinity; ordinary numbers are safe
integers (`-(2^53-1)..2^53-1`); fractional and exponent notation reject; JSON
depth is capped at 16. Parsed objects carry a null prototype, so `__proto__`
is an ordinary own key (it does not invoke the prototype setter); the strict
schemas then reject it as an unknown property, along with any other key the
schema does not declare, including names on `Object.prototype`
(`constructor`, `toString`). u64 counters and the session are 16 lowercase
hex characters; `opId` is 32 lowercase hex characters. String offsets that
refer to product source text are explicit UTF-16 units and must not split a
surrogate pair.

Common fields: `op` (required, `^[a-z][a-z0-9_.-]{0,63}$`), `resource`
(`ResourceRef`), `args`, `value`, `status`, `final`, `error`, `effect`,
`baseRevision`, `opId`, `opEpoch`, `budgetMs`, `subscription`, `transfer`,
`digest`, `depends` (at most 8). Method inputs live under `args`, results
under `value`; `resource`, `status`, `final` and `digest` stay at the top
level. Resource identity never depends on JSON key order.

`ResourceRef` is `{kind, ns, key, revision?, rendition}`. **A wire reference
is a `ResourceRef`, never a local texture or surface handle.** Bounds: `ns`
128 bytes, `key` 256 bytes, `revision` and `rendition` 128 bytes. `kind` is
one of `1 tile, 2 texture, 3 glyph-run, 4 text-layout, 5 media-chunk,
6 terminal-cells, 7 file, 8 event`; kind selects semantics, codec selects the
wire encoding.

## Five message types

| Type | Name | Correlation | Behavior |
| --- | --- | --- | --- |
| 1 | REQUEST | `>0` | one `op`; ids do not repeat within a session |
| 2 | RESPONSE | echoes request | carries `status` (`ok`/`accepted`/`error`) and boolean `final`; exactly one terminal response has `final:true` |
| 3 | PUSH | `0` | subscription or control delivery; carries `subscription` or a stream-0 control op |
| 4 | CANCEL | original request id | sent on stream 0 with `op:"request.cancel"` and `targetStream`; provider still emits one terminal response on the original stream |
| 5 | INVALIDATE | `0` | authority content invalidation or consumer cache eviction |

Control ops are metadata names, not new types: `relay.hello`, `relay.ready`,
`relay.open`, `relay.close`, `relay.ping`, `relay.credit`, `relay.reset`,
`resource.get`, `resource.subscribe`, `resource.release`,
`resource.unsubscribe`, `request.cancel`, `resource.invalidate`,
`cache.evict`, `operation.status`, `operation.epoch`.

## Error codes

A RESPONSE with `status:"error"` carries a fixed `error.code`. **The peer
selects its action from the code, not from the English `message`** (message
is capped at 160 bytes, diagnostics only):

`UNSUPPORTED`, `INVALID`, `UNAUTHORIZED`, `BUSY`, `TOO_LARGE`, `STALE_BASE`,
`NOT_FOUND`, `CANCELLED`, `DEADLINE`, `OUTCOME_UNKNOWN`, `RESYNC_REQUIRED`.

Frame parsing itself returns the separate codes in `RELAY_FRAME_ERROR`
(`BAD_MAGIC`, `BAD_FLAGS`, `BAD_LENGTH`, `BAD_METADATA`, `TOO_LARGE`-class
`WIRE_TOO_LARGE`/`META_TOO_LARGE`, and so on) before any metadata handler
runs. The codec throws nothing; `encodeFrame`/`decodeFrame` return
`{ok:false, code}`.

## Codecs

`codec` identifies the data encoding: `0` no data (`dataBytes` must be 0),
`1` one strict UTF-8 JSON value, `0x0101` packed `r5g6b5le` u16LE pixels,
`0x0102` PMH1 mesh bytes, `0x0103` `coverage2-lsb` (four 2-bit samples per
byte, low bit first, 4-aligned rows), `0x0104` `indexed8-abgr` (1024-byte
u32LE ABGR palette then indices), `0x0201` FONT v3 blob, `0x0301` opaque
bytes with declared length and digest. `0x8000..0xffff` is the negotiated
extension range; a codec outside the negotiated set rejects the frame.

Chunked data repeats the same `resource`/`codec`/`transfer.id`/`total`, with
contiguous offsets from 0; the final chunk has `final:true` and
`offset + dataBytes == total`. Overlap, gaps, and out-of-range offsets
reject. The SHA-256 `digest` is checked over the assembled bytes before the
object is published.

## Limits negotiation

**A limit is a guarantee by the receiver about what it can hold; a sender
cannot advertise a larger limit to its peer.** HELLO and OPEN exchange
per-direction `rxLimits` (`maxWireBytes`, `maxMetaBytes`, `windowFrames`,
`windowBytes`, `maxPending`, `maxObjectBytes`, `maxAssemblies`,
`maxScratchBytes`); each side adopts `min(local, peer)`. `maxWireBytes` and
`windowBytes` must each hold at least one complete frame.

v1 proposals: control frames are 4096 bytes including the 48-byte header, the
control window is 8 frames / 32768 bytes, and `maxPending` is 8. Each
direction reserves two 256-byte sideband slots for `relay.credit`,
`relay.ping`, `relay.reset`, and CANCEL, so control can advance when the
normal window is full. Bulk attachments negotiate 65536-byte frames, a
2-frame / 131072-byte window, metadata capped at 2048 bytes, and at most two
concurrent assemblers. A session allows one bulk attachment and at most eight
nonzero streams. Heartbeat is 2 seconds with a 15-second no-progress
timeout; these are timing proposals, not measured recovery latency.

Credits are cumulative counters per target stream (`framesReleased`,
`bytesReleased` as u64 hex); a release cannot exceed the frames and bytes the
peer transmitted, and a counter is valid for one session. A CANCEL or local
timeout withdraws interest but does not return request or execution capacity
until the terminal response is consumed or the session ends.

## Session state machine

The guest and provider run one shared state machine,
`framework/src/relay/session.ts` (`RelaySession`); the provider imports it
from `tools/relay-wire.ts`. The machine holds no socket. It runs on a
`RelayTransportAdapter` with three operations: bounded
`trySend(bytes) -> "accepted" | "busy" | "offline"`, ordered record delivery
through `handleRecord`, and an authenticated `peer { id, grants }`. **Peer
identity comes from the adapter; HELLO metadata is never trusted for
identity.**

The machine has six phases: `idle`, `hello-sent`, `hello-received`,
`ready-sent`, `ready`, `closed`.

1. The guest sends REQUEST `relay.hello` on session 0 with `seq:1`,
   `correlation:1`, a 16-byte `bootNonce` (32 hex chars), its supported
   versions, profiles, codecs, kinds and `rxLimits`. The frame is at most
   4096 wire bytes.
2. The provider answers on session 0 with a random nonzero u64 `session`,
   its `peerNonce`, the echoed `bootNonce`, one exact selected `[major,
   minor]` version, the profile, codec and kind intersections, its grants,
   and `rxLimits` computed field by field as `min(local, peer)`. With no
   version/profile/kind intersection, or an app outside the adapter grants,
   it returns a final RESPONSE with `status:"error"` and an `error.code`
   (`UNSUPPORTED` or `UNAUTHORIZED`) and closes. The echoed codec and kind
   sets are optional metadata fields (the field table lists the
   intersection rule but the step-3 response list omits both fields); a
   guest that does not receive them keeps its own offer, and a set naming a
   codec or kind the guest did not offer tears the session down.
3. The guest sends REQUEST `relay.ready` on the new session confirming the
   selected version; the provider acks and both sides enter `ready`. Each
   direction's seq restarts at 1 on the new session.
4. REQUEST `relay.open` on stream 0 makes the provider allocate a nonzero
   stream id (1..8) for an app/namespace/profile binding. Stream ids are
   never reused inside the session; each stream's two directions keep
   independent seq counters starting at 1.
5. Business frames are admitted in `ready` on opened streams only. Frames
   that arrive before `ready`, on an unknown stream, or with a session that
   is not the pinned session are dropped; frames with an unknown op on
   stream 0 end the session. Installing an OPEN binding resets that stream's
   two seq counters, so an early frame on an id that OPEN later allocates
   cannot desync the new stream. `relay.reset` applies to a business stream;
   `targetStream: 0` is refused (the schema minimum is 1 and the handler
   drops it) so a forged reset cannot wipe the control-stream seq space.
6. REQUEST/RESPONSE `relay.ping` carries a u32 token echoed without clock
   interpretation. A ping is sent every 2 seconds with at most one
   outstanding; 15 seconds without an inbound frame ends the session; a
   `busy` send retries after 1.5 seconds.

**A reconnect or a guest realm reset is a new session: the machine discards
the session id, negotiation, every stream binding, every seq counter and
correlation counter, and restarts at `idle`.** Frames that name a prior
session fail the frame codec's session pin and are dropped as stale without
reaching the business callback; they do not tear down the current session.

seq allocation follows the header rule: a number is consumed when the frame
enters the ordered send stream, so a `busy` or failed send leaves the counter
where it was. On receive, seq must be exactly previous+1 per
`(session, stream)`; a gap or duplicate on stream 0 ends the session, and on
a business stream invokes the `onStreamError` resync hook.

Resource delivery is not in this layer. `sendBusiness` is the single
admission point P3/P4 extend with queue and credit checks; inbound
non-control frames go to `onBusinessFrame`, `relay.credit` and `relay.reset`
PUSH frames go to `onCredit`/`onReset` hooks, and OPEN authorization is an
`authorizeOpen` hook returning an error code or null.

`tools/relay-wire.ts` binds the machine to a byte channel:
`attachRelayProvider` (one connection), `attachRelayChannel` (guest side),
`relaySocketChannel` (node `net`), and `serveRelayTcp`, which takes an
`authenticate(socket)` callback returning the peer grants. Records are
reassembled by `RelayRecordDecoder` before they reach the machine, and a
record over the advertised bound destroys the connection without allocating.

**`RelayByteChannel.send` is an admission decision: it returns `false` only
when the frame was not taken.** A node `socket.write()` that returns `false`
has already queued the bytes and will still flush them, so
`relaySocketChannel` checks `writableLength + frameSize` against
`writableHighWaterMark` before writing (`socketCanAdmit`) and returns
`busy` without writing; a frame on an empty queue that alone reaches the
mark is still written, after which sends are busy until the queue drains.
Reporting a queued frame as busy would make the session roll its seq back
and reuse it on the retry, putting a duplicate seq on the wire.

## Tests and vectors

The cross-language vectors are generated, not hand-edited:

```sh
bun tests/fixtures/relay/generate.ts   # rewrites vectors/*.bin + constants.json
bun test tests/relay-frame.test.ts     # byte vectors, codec, reassembly
bun test tests/relay-session.test.ts   # handshake/negotiation/session/ping
bun test tests/relay-wire.test.ts      # provider over a TCP loopback
bun tests/contract.ts
```

`tests/fixtures/relay/vectors/*.bin` are complete wire records with a paired
`.json` giving the expected decode result or the exact frame error code. The
nine `example-*` vectors reproduce the R5 draft's Map/Term/Vault worked
frames byte-for-byte (48-byte header hex and total length pinned).
`constants.json` is the snapshot the C and Rust layers compare against;
`engine/core/src/spec.rs` regenerates from the same spec through
`bun contracts/spec/gen-rust.ts`.
