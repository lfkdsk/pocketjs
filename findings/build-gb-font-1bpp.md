# Builder: the GB font ships 1bpp

- Repo: `lfkdsk/pocketjs`, base commit `9ca1785` (`scout: Vapor artifact size baseline and 3 candidates`)
- Date: 2026-09-07
- Task 439, implementing **candidate 2** of `findings/scout-artifact-size.md` §4.
- Not pushed, no PR opened.

## 1. The change

The DMG has one background palette, so Pocket Vapor bakes logical palettes into two glyph
**styles**: style 0 is ink shade 3 on paper shade 0, style 1 is the inverse. That needs
2 × 95 × 16 B = 3040 B of 2bpp interleaved tile data in VRAM — but those 3040 B hold no bit that
`FONT8`'s 760 B does not:

- shade 3 sets both bitplanes and shade 0 clears both, so every row is `bits, bits`;
- style 1 is style 0 complemented, byte for byte.

So the ROM now carries the 760 B `FONT8` bitmap and `upload_font` reconstructs the 3040 B while
writing VRAM, which it already looped over.

| file | change |
|---|---|
| `vapor/compiler/compile.ts:2439` | the `gb` case calls `emitFont1bpp()`, as `esp32`/`playdate` already did; `emitFontGb()` is deleted |
| `vapor/compiler/compile.ts:2318` | memory plan prices the gb font at `95*8`, so the reported figure matches what is emitted |
| `vapor/runtime/gb/vapor_gb.c:124` | `upload_font` expands 1bpp → two styles of 2bpp, one pass, two write cursors |
| `vapor/runtime/vapor.h:111` | the documented ABI now says 1bpp + runtime expansion |

## 2. Occupancy, five runs each side

Raw GB ROM size cannot move: `gb` emits a fixed 32 KB ROM-only cartridge, so both sides read
32768 B (scout §2.2). The metric is **bytes before the trailing `0xFF` pad run**, measured by
`findings/measure-artifact-size.sh`.

| run | baseline `todo.gb` | modified `todo.gb` |
|---|---|---|
| 1 | 11383 | 9140 |
| 2 | 11383 | 9140 |
| 3 | 11383 | 9140 |
| 4 | 11383 | 9140 |
| 5 | 11383 | 9140 |
| 6 (re-check after restoring from the mutation runs) | — | 9140 |

**11383 → 9140 B, −2243 B (−19.7%).** Slightly better than the scout's 9172 prototype (−2211).

Both examples, and the two other buildable targets, one run each side:

| example | target | metric | before | after | delta |
|---|---|---|---|---|---|
| todo | gb | used bytes | 11383 | **9140** | **−2243** |
| playdate-six-button | gb | used bytes | 8933 | **6690** | **−2243** |
| todo | gba | ROM bytes | 9356 | 9356 | 0 |
| todo | nes | PRG used | 9162 | 9162 | 0 |

The saving is a constant 2243 B, independent of app complexity — as expected for a fixed table.

sha256 (first 12) — GB changes, the others are byte-identical artifacts:

| artifact | before | after |
|---|---|---|
| `todo.gb` | `8dc4d4132e16` | `e555d298766e` |
| `playdate-six-button.gb` | `ee193fb8e6af` | `647c8df254a3` |
| `todo.gba` | `08094dab8463` | `08094dab8463` (same) |
| `todo.nes` | `8f825526b0a5` | `8f825526b0a5` (same) |

## 3. Symbol attribution

From sdcc's `app.map` for `todo.gb`:

| area | before | after | delta |
|---|---|---|---|
| `_CODE` | 9335 B | **7092 B** | **−2243 B** |
| `_HOME` | 556 B | 556 B | 0 |
| `_DATA` (RAM) | 1143 B | 1143 B | 0 |

`_CODE`'s delta equals the occupancy delta exactly, so the whole saving is accounted for and nothing
moved into another area. The table itself shrinks 3040 → 760 B (−2280); the expansion loop costs
back **37 B** of code. State RAM is untouched — this trades ROM for boot cycles only.

`_vp_font_tiles` moves from `0x2054` to `0x2079` (both `gen_app`), i.e. it is still one ROM symbol in
the generated translation unit, not relocated into RAM.

## 4. The font bytes in VRAM are unchanged, proven from the emulator

`vapor/tests/gb-font.test.ts` boots a real `todo.gb` in headless libmgba, reads all 3040 B of tile
data at `0x8010` off the bus, and compares them byte for byte against a reference expansion built
in the test from `FONT8` and the DMG pixel-format rule alone — it re-derives the format rather than
importing either the compiler's emitter or the runtime's loop.

**The test was written and run against the unmodified base commit first**, where it passed
(3 tests / 3045 assertions). That is what makes it a regression test rather than a restatement of the
new code: the bytes it pins are the baseline's bytes.

```
# on base 9ca1785, compiler and runtime untouched
$ bun test vapor/tests/gb-font.test.ts
 3 pass / 0 fail / 3045 expect() calls

# after the change
$ bun test vapor/tests/gb-font.test.ts
 3 pass / 0 fail / 3045 expect() calls
```

Three properties are checked: every byte against the reference expansion (failures name style, glyph,
character, row and plane); the three structural facts the encoding leans on, read straight off VRAM
(both planes equal the `FONT8` row for style 0, both are its complement for style 1); and that tile 0
stays blank while the tile just past the font region stays zero, which catches an expansion that runs
long.

## 5. Cross-target isolation

Generated C for all five targets, base vs modified, from the same inputs:

```
todo.gba.c:      IDENTICAL
todo.gb.c:       DIFFERS   (1 line: the vp_font_tiles initializer)
todo.nes.c:      IDENTICAL
todo.esp32.c:    IDENTICAL
six.playdate.c:  IDENTICAL
```

One line, in one target. `vapor/runtime/gb/**` and the `gb` case of `emitTargetData` are the only
code paths touched; `emitFontGba`, `nesFontBytes`, and `emitFont1bpp`'s other two callers are
unchanged. The memory plan's font figure is asserted per target
(`vapor/tests/compiler.test.ts`): gb 760 B, gba 3040 B, nes 3040 B.

ESP32 and Playdate artifact sizes are **not measured** — no SDK on this host, both fail at the link
step (`IDF_PATH` / `PLAYDATE_SDK_PATH` unset). Their generated C is byte-identical, which is the
strongest available evidence for those two.

## 6. Test suite

```
$ export MGBA_PREFIX=/tmp/mgba-prefix
$ export CC65_LIB=/home/linuxbrew/.linuxbrew/share/cc65/lib/none.lib

# base 9ca1785
 71 pass / 0 fail / 7398 expect() calls / Ran 71 tests across 7 files

# after the change (+3 gb-font tests, +2 compiler tests)
 76 pass / 0 fail / 10456 expect() calls / Ran 76 tests across 8 files
```

All four parity rigs green, **NES included**: the scout's §1.1 correction holds — the NES red is a
hardcoded `/opt/homebrew` path at `vapor/compiler/rom.ts:20`, not a corrupt library, so
`CC65_LIB=/home/linuxbrew/.linuxbrew/share/cc65/lib/none.lib` makes it pass. Oracle, GBA, GB and NES
each compare every cell of `TODO_TAPE` against the vue-vapor oracle.

## 7. Mutation: what has teeth and what does not

Three single-bit mutations, each applied alone, everything else restored between runs:

| # | mutation | `gb-font.test.ts` | `compiler.test.ts` | `parity.test.ts` |
|---|---|---|---|---|
| 1 | runtime writes `bits ^ 0x01` into style 0's plane 1 | **2 of 3 fail** | pass | **6 pass — misses it** |
| 2 | runtime drops the `~` for style 1 | **2 of 3 fail** | pass | **6 pass — misses it** |
| 3 | compiler flips bit 1 of row 3 in every emitted glyph | **2 of 3 fail** | **2 fail** | not run |

Mutation 1 reports as
`style 0 glyph 1 ('!') row 0 plane 1: got 0x19 want 0x18` — the failure names the pixel.

**Parity catches neither runtime mutation, and this is the load-bearing result of this section.**
The GB rig's VRAM probe reads the *background map* (tile indices at `0x9800`) and decodes an index
back to a character and a style; it never reads tile *pixels*. So a corrupted font renders wrong
glyphs on a real Game Boy while every parity assertion still passes. Before this task, nothing in the
suite constrained the GB font's pixels — which is exactly why the byte-exact VRAM test had to exist
before the encoding changed, and why it, not parity, is the guard on this optimization.

Mutation 3 also fails the esp32 and playdate tests, since all three targets now share
`emitFont1bpp()`. That coupling is intended and worth knowing: one emitter, three targets asserting
its output.

## 8. Cost not paid in ROM

The expansion is **not timed**. It moves 760 iterations of load / two stores / complement / two
stores into boot, replacing a 3040-byte copy loop; it runs once with the LCD off, before
`app_init`, and both are far inside the GB rig's 90-frame boot margin (`A 90`), which passed
unchanged. No cycle count was taken, so "boot is not measurably slower" is **not** claimed.

sdcc emits `warning 110: conditional flow changed by optimizer` for `gen_app.c` on this build. The
scout established it is pre-existing (it appears compiling the unpatched generated C with the same
flags); this change neither introduces nor removes it.

## 9. Reproducing

```bash
export MGBA_PREFIX=/tmp/mgba-prefix
export CC65_LIB=/home/linuxbrew/.linuxbrew/share/cc65/lib/none.lib
ln -s /var/tmp/oss/pocketjs/node_modules node_modules   # do not bun install in a worktree

OUT_BASE=/tmp/t439 ./findings/measure-artifact-size.sh r1   # §2
grep -E '^_(CODE|DATA)' /tmp/t439/r1/todo-gb/gen-gb/app.map # §3
bun test vapor/tests/gb-font.test.ts                        # §4
bun test vapor/tests/                                       # §6, expect 76/76
```

## 10. Open

- **ESP32 / Playdate artifact bytes** — no SDK, not measured (§5).
- **Boot cycles** — not measured (§8).
- **GBA candidate 1 (−2172 B) and candidate 3 (−108 B)** remain unimplemented. Candidate 1 is the
  same transformation on `emitFontGba`, and the GBA parity rig *does* read tile pixels
  (`vapor/tests/parity.test.ts:60`, entrySize 2), so it is better covered than GB was. Candidate 3
  touches the same `vapor.h` ABI block. Both are separate tasks.
- **The GB/NES parity blind spot found in §7** is broader than the font: no GB or NES test reads tile
  pixel data at all. A pixel-level probe for the NES CHR-ROM font would close the matching hole
  there; filed as a spawn proposal.
