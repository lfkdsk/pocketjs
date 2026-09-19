# M1: relay+map runtime branch (relay L1/L2 + tile-viewport/resource-pack)

## Result

| item | value |
| --- | --- |
| branch | `fleet/task-1129` (worktree `/home/tangollvm/.fleet/worktrees/task-1129`, repo `/var/tmp/oss/pocketjs`) |
| runtime tip (merge commit) | `9db60c0ef6e84a5dadecca3125656e8f9babaf36` |
| parents | `1b31d3ff` (`relay-l1-l2` = `upstream/main@780218d` + 62 relay commits), `e2226e8f` (`upstream/feat/local-resource-packs`, 25 commits since fork `10aee589`) |
| branch tip | the `verify:` commit on top of `9db60c0e`; it adds only this file |
| diff vs `1b31d3ff` | 98 files, +5391 / -340 |
| conflicts | 24 files (matches the commander's count), all resolved by hand; 5 more files auto-merged wrong and fixed |
| method | `git merge --no-ff` (one merge commit, both histories kept). Not rebased; see below |
| pushed / PR | no |

The existing `relay+map-runtime` branch (checked out at `/tmp/relay-map`, still `1b31d3ff`) was not touched. Fast-forward it to `9db60c0e` (or to the branch tip) to publish.

## Why merge instead of rebase

| measurement | value |
| --- | --- |
| feature commits since fork | 25 |
| main-only commits the feature lacks | 47 (`10aee589..780218d`) |
| feature commits touching a file main also changed | 14 of 25 |
| feature commits touching `tools/offload-provider.ts` | 7 (2b5188cd, 42b74f17, b43e0df4, e04c6b91, 560346a9, a46b6480, 23aaff18) |
| main commit that rewrote that file onto `tools/companion-session.ts` | `061c6be1 feat(sim): add bounded prediction and shared companion sessions (#389)` |
| feature commits touching `hosts/3ds/src/qjs.c` | 6 |
| feature commits touching `framework/src/offload.ts` | 4 |

A rebase replays each feature commit onto the relay branch, so the provider would have to be re-ported onto `companion-session.ts` seven times, once per commit, with no way to build or test the intermediate states. The merge produces one resolution that is built and tested once. The feature branch is itself an upstream branch (`upstream/feat/local-resource-packs`), so upstream's own landing of that PR after relay is exactly this merge shape; the 25 upstream commits stay byte-identical and cherry-pickable.

## Conflict decisions (24 files)

Rule applied: main (with relay) is the baseline; the feature branch adds only what main lacks. "ours" = `relay-l1-l2`, "theirs" = feature.

| # | file | hunks | decision | why |
| --- | --- | --- | --- | --- |
| 1 | `.github/workflows/3ds-runtime.yml` | 3 | union of both `paths` lists; main's `bun test` step kept and the feature's `--conditions=browser` offload/resource step added after it | both sides extended the same trigger list; neither is stale |
| 2 | `contracts/spec/offload.ts` | 1 | theirs (uploadImage/uploadMesh/release*, `OffloadRequest.response`, tickets, `OFFLOAD_IMAGE`, `OFFLOAD_MESH`, `OffloadProviderReply`) with ours' `uploadCoverage` doc block (3DS 16384-pixel envelope) | main changed only the coverage contract text; the feature adds new members |
| 3 | `engine/core/src/draw.rs` | 5 | ours + theirs: `font_revisions` (main) and `meshes`, `mesh_commands` (feature) side by side in the emitter struct, `build`, and both call sites; the feature's `mesh_commands: bool,    frame: u64,` split into two lines | independent additions to the same parameter lists |
| 4 | `engine/core/src/lib.rs` | 6 | ours (`paint_cache` replaced `discs` on main) + theirs (`meshes`, `mesh_commands` fields, `new()` init, four `draw::build` calls) | the feature was written against the old `discs` field |
| 5 | `engine/core/src/tests.rs` | 1 | ours (main's font-stream tests) + theirs (`retiring_texture_invalidates_handle_before_gpu_owner_drops`, `external_texture_has_dimensions_and_generations_without_cpu_pixels`) with the shared `#[test]` line duplicated for the second block | both sides appended tests at EOF |
| 6 | `engine/wasm/src/lib.rs` | 1 | ours (font stream exports) + theirs (`ui_upload_mesh`, `ui_free_mesh`, `ui_set_mesh`) | both appended exports at EOF |
| 7 | `framework/src/resource-cache.ts` | 2 | ours' `ResourceResult` shape with the `revalidated` variant (relay §3.8) kept; the feature's `releaseResponse` calls inserted on the `"value" in result` paths: over-budget replies, `materialize` `try/finally`, late/duplicate deliveries, `stop()`, and the synchronous-throw path | the feature indexed `result.value` on a type that no longer always has it |
| 8 | `framework/src/resource.ts` | 1 | ours (nothing): `ResourceBoundary` lives in `resource-boundary.ts` on main | the feature only reformatted the inline copy main had already moved |
| 9 | `hosts/3ds/Makefile` | 1 | `OBJECTS` gets both `media.o` (main) and `asset_pack.o` (feature) | both added an object |
| 10 | `hosts/3ds/src/main.c` | 3 | both includes; `media_start`/`asset_pack_start` and `media_stop`/`asset_pack_stop` each under their own `#ifdef` | both hooked the same start/stop points |
| 11 | `hosts/3ds/src/offload_queue.h` | 1 | ours (`#include "../../shared/offload_queue.h"`); the feature's `image_token` field and `offload_push_ticket` added to `hosts/shared/offload_queue.h` | main moved the queue to the shared header (`docs/RELAY.md` refers to it) |
| 12 | `hosts/3ds/src/qjs.c` | 4 | both includes; enum = main's `HostMedia*` + feature's `HostPack*` + feature's extended `HostOffload*` row; `install_host` registers `media` and `resourcePacks` under their own `#ifdef`; `qjs_shutdown` = `media_forget_guest()` + `offload_reset()` + `asset_pack_reset()` | independent host tables |
| 13 | `hosts/psp/build.rs` | 1 | ours (slot validated as 16 hex digits) | the feature's unvalidated one-liner is the older form |
| 14 | `hosts/psp/src/lib.rs` | 1 | `offload_local`, `offload_image` (main) + `offload_packet`, `mesh`, `analog` (feature) | both added modules |
| 15 | `hosts/psp/src/main.rs` | 3 | h1 ours (`devtools-offload` gating is a superset of the feature's condition); h2 feature's `input_tick`/`elapsed` and 7-argument `JS_Call` plus main's `offload_local::frame()`; h3 `offload_local::reset()` + `mesh::reset()` + `ge::retire_textures()` | main added the local provider; the feature added elapsed-time input and mesh teardown |
| 16 | `hosts/psp/src/offload.rs` (add/add) | 6 | theirs (131072-byte data slots, `BORROWED` tickets, `release`, `upload`); main's boot-allocation comment line restored | main's copy (`b5e2a274`) is an older snapshot of the same file: feature = main + 48 lines, minus one comment |
| 17 | `hosts/psp/src/offload_packet.rs` (add/add) | 3 | theirs (`DATA_MAX`, kinds 0/1/2 admission, `admission_and_generations` test) | superset of main's JSON-only validator |
| 18 | `tests/3ds-profile.test.ts` | 1 | `"media.playback"` (main) + `"io.resource-pack"` (feature) | both appended a capability |
| 19 | `tests/offload-provider.test.ts` (add/add) | 1 | main's readiness/reconnect test + the feature's five tests (duplex credit fixture, process crash, repeated disconnects, wedged deadline, 64-image burst) in one file | both are valid against the ported provider; 6 tests pass |
| 20 | `tools/3ds-profile.ts` | 1 | as row 18 | same table |
| 21 | `tools/3ds.ts` | 1 | `POCKETJS_MEDIA` (main) + `POCKETJS_ASSET_PACK` (feature) | both env flags feed the Makefile |
| 22 | `tools/offload-provider.ts` | 5 | rewritten: main's `connectCompanionSession` transport kept; the feature's process isolation, image/mesh reply encoding, eight-credit admission (`pending + queued replies + blocked write < 8`), 5 s connect timeout, `Session N:` trace lines and executor reaping ported as provider state. Main's `ready === true` skip is kept. `dispatchOffload` is the feature's (image/mesh returns) | main rewrote the file on a shared transport; the feature rewrote the raw socket |
| 23 | `tools/offload-usb-provider.ts` (add/add) | 5 | theirs (process-isolated executor, kinds 1/2 packets, `stats` file, epoch rotation) | main's copy is the older 196-line snapshot; main's two callers (`tools/text-provider.ts`, `tools/text-lab-companion.ts`) pass the same options |
| 24 | `tools/test.ts` | 1 | ours (relay/ime/text tests) + the feature's `offload-images`, `offload-meshes`, `tile-viewport`, plus `offload-usb`, `resource-pack`, `resource-pack-view` | main's `tests/test-suite.test.ts` (#433) fails for any `tests/*.test.ts` not declared in a stage |

`tools/companion-session.ts` (no conflict, main-only file) was extended to carry the ported provider: `write(frame)` for framed binary records, `admit()` read gate that pauses the socket and holds the unconsumed chunk suffix, `resume()`, `drained` callback, `disconnect(reason)`, `connectTimeoutMs`, and a `disconnected` return value that defers the reconnect timer until executor teardown settles. Existing callers (the provider, `tests/companion-session.test.ts`) keep their behaviour; the test passes.

## Auto-merged files that were wrong (fixed in the merge commit)

| file | problem | fix |
| --- | --- | --- |
| `contracts/spec/platforms.ts`, `tests/platform-contracts.test.ts` | the feature (fb36925b) added `"io.offload"` to the PSP target; main already lists it after `"input.buttons"`, so the merge had it twice | feature line dropped in both files |
| `hosts/psp/src/ffi.rs` | the feature added a second `js_offload_session/submit/take` trio and a second `globalThis.offload` object next to main's (which also carries `local`, `uploadCoverage`, `uploadIndexedImage`) | duplicates removed; `uploadMesh`, `uploadImage`, `releaseMesh`, `releaseImage` and `ui().set_mesh_commands(true)` folded into main's block; main's lazy `offload::start()` in `session()` kept instead of the feature's eager start in `register()` |
| `framework/src/resource-cache.ts` (three lines outside the conflict hunks) | `releaseResponse(result.value)` on the union type that includes `{ ok: true; revalidated: true }` (tsc error) | guarded with `"value" in result` |
| `hosts/shared/offload_queue.h` | the feature's queue change targeted the 3DS-local copy that main had replaced with an include | `image_token` + `offload_push_ticket` added to the shared header; `offload_push` stays as a wrapper |
| `tools/companion-session.ts` | `let teardown` without initializer (tsc TS2454) | initialized |

## Feature commits dropped or rewritten

All 25 commits are in the history unchanged (merge). The following parts of them do not survive into the merged tree:

| commit | part | fate |
| --- | --- | --- |
| 42b74f17, b43e0df4, e04c6b91, 2b5188cd, 560346a9, a46b6480, 23aaff18 | `tools/offload-provider.ts` raw-socket implementation | rewritten onto `companion-session.ts` (row 22); behaviour kept, verified by the feature's own five tests plus the duplex-credit fixture |
| fb36925b `test(psp): cover USB offload capability admission` | `"io.offload"` added to the PSP target and its assertion | dropped: main already declares it |
| 2b5188cd | `hosts/3ds/src/offload_queue.h` edit | moved to `hosts/shared/offload_queue.h` |
| 2b5188cd (resource.ts reformat) | inline `ResourceBoundary` | dropped: main's `resource-boundary.ts` is the definition |
| 23aaff18 | `hosts/psp/build.rs` slot line, eager `offload::start()` + second `offload` global in `ffi.rs`, deleted comment in `offload.rs` | dropped in favour of main's versions |
| 2b5188cd / b43e0df4 | `3ds-runtime.yml` test step that replaced main's | kept as an additional step |
| 5394eb2f | `hosts/psp/src/main.rs` `JS_Call` with 2 arguments replaced | superseded by the 7-argument call that also keeps main's `offload_local::frame()` |

Nothing from the feature's `framework/src/tile-viewport.ts`, `resource-pack.ts`, `drag-filter.ts`, `tools/resource-pack.ts`, `hosts/3ds/src/asset_pack*.{c,h}`, `hosts/3ds/src/offload_image.h`, `hosts/psp/src/{mesh,analog}.rs`, docs, or tests was altered.

## Acceptance (all on `9db60c0e`, this machine, `PATH=$HOME/.cargo/bin:$PATH MGBA_PREFIX=/tmp/mgba-prefix`)

| check | command | result |
| --- | --- | --- |
| baseline | `bun tools/test.ts` on `1b31d3ff` (`/tmp/task1129-base`) | `test: 14/14 stage(s) green in 135.6s` |
| suite | `bun tools/test.ts` | `test: 14/14 stage(s) green in 774.5s` (unit 82.8s; "handheld models" 613.3s of which 6.3s were its 12 tests: its `tools/wasm.ts` prep waited on cargo's package-cache lock held by the concurrent PSP build-std check below) |
| contracts | `bun tests/contract.ts` | `contract: all green` |
| generators | `bun run gen` then `git status --short` | `package.json exports already current`; `spec.rs`/`generated.rs` rewritten identical; no drift |
| tape | `bun tools/tape.ts replay hero-main tests/tapes/hero-main.tape.json --assert tests/tapes/hero-main.hashes.json` | `tape: OK — 180 frames match tests/tapes/hero-main.hashes.json` |
| relay TS | in the suite's unit stage (`tests/relay-*.test.ts`, 11 files) | unit stage green |
| relay C | `tests/relay-frame-c.test.ts` in the unit stage | green |
| relay Rust std | `cd engine && cargo test -p pocket-relay` | 27 + 8 + 10 + 1 passed, 4 ignored (throughput) |
| relay Rust no_std | `cargo test -p pocket-relay --no-default-features` | same counts |
| core | `cd engine/core && cargo test` | 150 passed (includes `mesh::tests` and the two new texture tests) |
| engine workspace | `cd engine && cargo check --workspace` | `Finished` in 54.05s, exit 0 |
| 3DS core wrapper | `cd hosts/3ds/core && cargo +nightly-2026-07-02 check --release` (armv6k-nintendo-3ds via build-std) | `Finished` in 1m 36s, exit 0 (`ui_upload_mesh`, `ui_mesh_*`, `ui_register_external_texture` bind against the merged core) |
| ui-cabi | `cd engine/ui-cabi && cargo check` | exit 0 |
| desktop host | `cd hosts/desktop && cargo check` | `Finished` in 14.81s, exit 0 |
| tsc | `node_modules/.bin/tsc --noEmit` | exit 0, no output |
| targeted TS | `bun test` over the 14 files touched by the port (offload-provider, companion-session, resource-cache, offload, platform-contracts, test-suite, offload-images, offload-meshes, offload-usb, resource-pack, resource-pack-view, tile-viewport, npm-package, 3ds-profile) | 137 pass, 1 fail (`npm-package` needed `cargo` on PATH; 4/4 on rerun with PATH) |
| exports | `package.json` lines 173/175: `./resource-pack`, `./tile-viewport`; `framework/compiler/subpaths.ts` lines 74/76; files present (6516 and 10570 bytes) | present |

## Not verified on this machine

| area | why | what was done instead |
| --- | --- | --- |
| `hosts/psp` Rust (offload.rs, offload_packet.rs, ffi.rs, main.rs, mesh.rs, analog.rs, ge.rs) | `cargo +nightly check -Zbuild-std -Zjson-target-spec --target targets/mipsel-sony-psp.json` stops in `libquickjs-sys`'s C build: the host clang lacks the PSP SDK libc (`patch.h: conflicting types for 'FILE'`); no `cargo-psp` / pspsdk on this box | every conflict hunk and the ffi dedupe were read back after editing; the feature's code is unchanged apart from the comment line |
| `hosts/3ds` C (`gfx.c`, `qjs.c`, `main.c`, `asset_pack.c`) | no devkitARM/libctru and no Docker for the `devkitpro/devkitarm` image | `hosts/3ds/src/offload.c` (with the shared queue header and `offload_image.h`) is compiled with clang `-fsanitize=address,undefined` by `tests/offload-images.test.ts` and exercised end to end (image + mesh tickets, realm reset); the 3DS core Rust wrapper type-checks |

## Reproduce

```sh
cd /home/tangollvm/.fleet/worktrees/task-1129        # branch fleet/task-1129
export PATH="$HOME/.cargo/bin:$PATH" MGBA_PREFIX=/tmp/mgba-prefix
bun install --frozen-lockfile
bun tools/test.ts                                    # 14/14
bun tests/contract.ts && bun run gen && git status --short
bun tools/tape.ts replay hero-main tests/tapes/hero-main.tape.json --assert tests/tapes/hero-main.hashes.json
(cd engine && cargo test -p pocket-relay && cargo test -p pocket-relay --no-default-features && cargo check --workspace)
(cd hosts/desktop && cargo check)
(cd engine/core && cargo test)
(cd hosts/3ds/core && cargo +nightly-2026-07-02 check --release)
node_modules/.bin/tsc --noEmit
```

Logs for the runs above: `/tmp/task1129-base-test.log`, `/tmp/task1129-merge-test.log`, `/tmp/t1129-batch1.log`, `/tmp/task1129-cargo-checks.log` (not committed).
