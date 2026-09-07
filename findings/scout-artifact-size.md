# Scout: Pocket Vapor artifact size

- Repo: `lfkdsk/pocketjs`, baseline commit `1b452c1a9864b5122f65c5c117da9a4f18cf30c7`
  (`feat(vapor): overlay allocation for frame-local temporaries`)
- Date: 2026-09-07
- Scope of this task: **investigation only**. No file under `vapor/`, `site/`, or `docs/` was
  modified. Every prototype in this report was built from *copies* under `/tmp/t405/`; nothing was
  pushed and no PR was opened.
- Metric scope: **ROM/firmware bytes and the ROM-resident data tables that occupy them.** State RAM,
  compiler wall-clock, and effect/dirty-bit redundancy are deliberately out of scope for this scout.

## 1. Environment

| tool | version | path |
|---|---|---|
| bun | 1.3.14 | `/home/linuxbrew/.linuxbrew/bin/bun` |
| arm-none-eabi-gcc | GCC 16.2.0 | linuxbrew |
| sdcc | 4.6.0 #16555 | linuxbrew |
| cc65 / ca65 / ld65 | V2.18 (binaries), lib 2.19 | linuxbrew |
| rgbfix, makebin | — | linuxbrew |

Required environment:

```bash
export MGBA_PREFIX=/tmp/mgba-prefix
export CC65_LIB=/home/linuxbrew/.linuxbrew/share/cc65/lib/none.lib
bun install --frozen-lockfile     # a fresh worktree has no node_modules
```

`bun install` is not optional in a fresh worktree: without it every compile dies at
`vapor/compiler/compile.ts:209` with `TypeError: undefined is not an object (evaluating
'ts.ScriptTarget.ESNext')`.

### 1.1 Correction to the assumed test baseline

The goal context states the local baseline is **65/66 with NES parity red**, diagnosed as a corrupt
`none.lib` / an ld65-2.18-vs-lib-2.19 version mismatch. **That diagnosis does not hold on this
machine.** The failure is a hardcoded macOS path:

```ts
// vapor/compiler/rom.ts:20
const CC65_LIB = process.env.CC65_LIB ?? "/opt/homebrew/share/cc65/lib/none.lib";
```

`/opt/homebrew` does not exist on this Linux host, and the real error text is
`ld65: Error: Input file '/opt/homebrew/share/cc65/lib/none.lib' not found` — not a read error.
Pointing `CC65_LIB` at the linuxbrew lib makes the whole suite green, twice:

```
$ env -u CC65_LIB MGBA_PREFIX=/tmp/mgba-prefix bun test vapor/tests/
 65 pass / 1 fail / Ran 66 tests across 7 files

$ MGBA_PREFIX=/tmp/mgba-prefix \
  CC65_LIB=/home/linuxbrew/.linuxbrew/share/cc65/lib/none.lib bun test vapor/tests/
 71 pass / 0 fail / 7398 expect() calls / Ran 71 tests across 7 files   # run 1
 71 pass / 0 fail / 7398 expect() calls / Ran 71 tests across 7 files   # run 2
```

Consequence for downstream tasks: **all four parity rigs (oracle, GBA, GB, NES) are available here**,
so a builder can hold NES parity green rather than restricting itself to the C layer.

## 2. Target / example matrix

Buildable locally: **GBA, GB, NES**. Not buildable — no SDK on this host, so **not measured**:

- `esp32` — needs ESP-IDF (`IDF_PATH` unset, `~/esp/esp-idf` absent), `vapor/compiler/esp32.ts:93`
- `playdate` — needs the Playdate SDK (`PLAYDATE_SDK_PATH` unset), `vapor/compiler/playdate.ts:58`

`vapor/examples/todo/todo.playdate.tsx` compiles for **no** local target: it uses
`RelativeAxis.Primary`, and GBA/GB/NES reject it with `VT102: <target> has no adapter for relative
axis Primary` (`vapor/compiler/compile.ts:224`; the axis table is `compile.ts:61-65`, where only
`playdate` lists axis 0). So the measurable matrix is 2 examples × 3 targets.

### 2.1 Raw bytes, two independent runs

Harness: `findings/measure-artifact-size.sh <run-tag>` (committed alongside this report), which wipes
its output dir, runs the CLI per pair, and prints `stat -c%s`, the occupancy figure of §2.2, and a
sha256 prefix. Five runs (`runA`..`runE`, the last through the in-repo copy) produced identical
output; two are tabulated:

| example | target | run A bytes | run B bytes | sha256 (12) | stable |
|---|---|---|---|---|---|
| todo | gba | 9356 | 9356 | `08094dab8463` | yes |
| todo | gb | 32768 | 32768 | `8dc4d4132e16` | yes |
| todo | nes | 40976 | 40976 | `8f825526b0a5` | yes |
| playdate-six-button | gba | 6420 | 6420 | `f91dbf138166` | yes |
| playdate-six-button | gb | 32768 | 32768 | `ee193fb8e6af` | yes |
| playdate-six-button | nes | 40976 | 40976 | `e51d9d94f058` | yes |

Byte-identical and hash-identical across both runs — the build is deterministic.

### 2.2 Raw size is the wrong metric on GB and NES

GB and NES emit **fixed-size padded cartridges**: 32 KB ROM-only for GB, and for NES a 16 B iNES
header + 32 KB PRG + 8 KB CHR = 40976 B, forced by `fill = yes` in the generated ld65 config
(`vapor/compiler/rom.ts:184-186`). Both examples therefore report identical raw sizes despite very
different content, and **no code-size optimization can move those numbers.** Use occupancy instead:

| target | occupancy metric | todo | six-button |
|---|---|---|---|
| GBA | `.text` from `arm-none-eabi-size -A app.elf` | **9356 B** | **6420 B** |
| GB | bytes before the trailing `0xFF` pad run | **11383 B** | **8933 B** |
| NES | 32 KB PRG minus its longest `0xFF` fill run | **9162 B** | **5933 B** |

These occupancy figures separate the two examples cleanly (GB 11383 vs 8933, NES 9162 vs 5933) where
raw bytes could not (32768 vs 32768, 40976 vs 40976) — which is the evidence that occupancy, not raw
size, is the metric a builder should report on GB and NES.

On GBA, `.text` equals the ROM byte count exactly (9356 = 9356), so the section table reconciles
with the artifact with zero padding delta. GB's used-byte figure includes the `_HOME`/`_CODE` layout
pinned at `rom.ts:169`. NES PRG's longest fill run is 23606 B at CPU `$a3c4`, leaving 9162 B used
(the `VECTORS` segment at `$fffa` sits above the run and is counted).

## 3. Hotspot evidence

`arm-none-eabi-nm --print-size --size-sort` on the todo GBA ELF, largest symbols:

```
00003040 T vp_font_tiles      <-- 32.5% of the entire 9356 B ROM
00000568 T main
00000424 t eff_1
00000296 T __divsi3
00000244 T __udivsi3
00000264 t c_filtered
00000220 t eff_0
00000208 T app_init
00000192 T vp_palettes
```

**One data table is a third of the ROM.** On `playdate-six-button` the same 3040 B table is
**47.4%** of its 6420 B. The font is emitted into the generated C per app, and the whole table is
one line of `gen_app.c` (`grep -c vp_font_tiles` → 1 definition site).

### 3.1 The font table stores 3040 B of bytes carrying 760 B of information

The source of truth is `FONT8` in `vapor/compiler/font.gen.ts:6` — 95 glyphs × 8 bytes = **760 B**,
1 bit per pixel. Each target's emitter then expands it:

- `emitFontGba()` (`vapor/compiler/compile.ts:2355-2368`) writes 4bpp: 95 × 32 B = 3040 B, but every
  pixel is only ever `INK`(1) or `PAPER`(2). Measured over the emitted table, the set of distinct
  nibble values is exactly `{1, 2}` — **1 bit of real information per 4-bit pixel, a 4× expansion.**
- `emitFontGb()` (`compile.ts:2379-2400`) writes 2 styles × 95 × 16 B = 3040 B. Measured on the
  emitted table: `lo == hi` for **every** row pair, and the second style is the bitwise NOT of the
  first for **all** 1520 bytes — **two independent 2× redundancies stacked, a 4× expansion.**

Both were checked by parsing the actual emitted arrays out of `gen_app.c`, not by reading the
emitter:

```
GBA font bytes: 3040 / distinct nibble values: [1, 2] / information content: 760 bytes (1bpp)
GB  font bytes: 3040 / lo==hi for all rows: True / style1 == bitwise-NOT style0: True
```

Note the asymmetry already present in the codebase: `esp32` and `playdate` **already** ship the
compact 1bpp form via `emitFont1bpp()` (`compile.ts:2371-2375`, 760 B), and `compile.ts:2318-2319`
prices the font as `95*8` for those two targets versus `95*32` for GBA/GB/NES. The expansion is a
per-target emitter choice, not a hardware requirement.

NES is **not** in scope for this: its font ships as CHR-ROM (`rom.ts:237-245`) inside a fixed 8 KB
CHR bank of which 3056 B are used and 5136 B are already zero pad. Shrinking it frees nothing.

### 3.2 GBA palette banks are 94% zero

`compile.ts:2437-2451` emits one full 16-entry GBA palette bank per style pair, but only indices
`INK`(1) and `PAPER`(2) are ever written. Measured on the emitted array for todo: 96 entries =
192 B, of which **12 are non-zero**. Every bank reads `[0, ink, paper, 0, 0, …, 0]`.
`vapor/runtime/gba/vapor_gba.c:96` copies the whole thing to `PAL_BG` verbatim.

## 4. Candidates

Exactly three, ordered by measured saving. Each was prototyped by patching *copies* of the generated
C and the runtime under `/tmp/t405/` and rebuilding with the same compiler flags `rom.ts` uses.

---

### Candidate 1 — emit the GBA font 1bpp and expand it during `upload_font`

- **Change:** `vapor/compiler/compile.ts:2355-2368` (`emitFontGba`) emits the 760 B `FONT8` bitmap
  instead of a 3040 B 4bpp table; `vapor/runtime/gba/vapor_gba.c:48-53` (`upload_font`) expands
  1bpp → 4bpp while writing VRAM, which it already loops over.
- **Baseline:** todo GBA `.text` **9356 B**; six-button GBA `.text` **6420 B**.
- **Measured after prototype** (not estimated):

  | example | before | after | saved |
  |---|---|---|---|
  | todo | 9356 | **7184** | **2172 B (23.2%)** |
  | six-button | 6420 | **4248** | **2172 B (33.8%)** |

  A constant 2280 B of table minus ~108 B of expansion code, independent of app complexity.
- **Correctness proof:** I replicated the prototype's C expansion in Python and compared all 3040
  bytes it writes to VRAM against the current `vp_font_tiles` array: **byte-identical: True**. The
  bytes reaching VRAM do not change, so no rendered cell can change.
- **Risk:** low-moderate. The table is not literally deleted, it moves into a boot loop, so
  (a) boot cost rises — the loop is 95×8 iterations of shift/mask instead of a 1520-word copy, paid
  once before the first frame, and untimed by this scout; (b) `vapor/runtime/vapor.h:110,116`
  documents and declares the current ABI, so the symbol rename must land in the same change;
  (c) the GBA parity rig reads VRAM directly (`vapor/tests/parity.test.ts:158`, `rig.vram.cmd`), so
  any expansion bug fails loudly rather than silently.
- **Parity verification:** `MGBA_PREFIX=/tmp/mgba-prefix CC65_LIB=… bun test vapor/tests/` must stay
  71/71. The GBA rig already compares VRAM tile data and per-cell palette banks after every press,
  which is exactly the surface this touches. Re-measure with `findings/measure-artifact-size.sh`.

---

### Candidate 2 — same treatment for the GB font, exploiting both redundancies

- **Change:** `vapor/compiler/compile.ts:2379-2400` (`emitFontGb`) emits the 760 B bitmap;
  `vapor/runtime/gb/vapor_gb.c:124-129` (`upload_font`) writes `row, row` for style 0 and
  `~row, ~row` for style 1.
- **Baseline:** todo GB used bytes **11383** (raw ROM stays 32768 B either way — see §2.2).
- **Measured after prototype:** **9172 B used → 2211 B saved (19.4% of used bytes).**
  The baseline was re-measured *through the same prototype harness* first and reproduced 11383
  exactly, so the delta is not a flag artifact. (Flags must match `rom.ts:155`:
  `-DVP_STR_CAP=24 -DVP_VIEW_CAP=32` for GB — my first attempt used the NES values and produced
  `warning: "VP_STR_CAP" redefined`, which invalidated that run.)
- **Correctness proof:** replicating the expansion in Python and comparing all 3040 VRAM bytes
  against the current `vp_font_tiles`: **byte-identical: True**.
- **Risk:** moderate, higher than candidate 1. Raw ROM size will not move, so the win must be
  reported as used bytes or `_CODE` size or it will look like a no-op. sdcc's SM83 codegen is the
  variable here: the expansion loop is 8-bit code and the `~` per byte is cheap, but sdcc emitted
  `warning 110: conditional flow changed by optimizer` in my prototype build. I re-checked: the
  identical warning at `gen_app.c:316` appears when compiling the **unpatched** generated C with the
  same flags, so it is pre-existing and not introduced by this change.
- **Parity verification:** the GB rig compares VRAM via `rig.vram.cmd` = PPU/bus read at
  `parity.test.ts:160` across the full `TODO_TAPE`; suite must stay 71/71.

---

### Candidate 3 — emit GBA palettes as sparse ink/paper pairs

- **Change:** `vapor/compiler/compile.ts:2437-2451` emits `vp_ink555[]`/`vp_paper555[]` (one entry
  per pair) instead of `vp_palettes[]` (16 per pair); `vapor/runtime/gba/vapor_gba.c:96` zeroes the
  bank region then writes indices 1 and 2 per pair.
- **Baseline:** todo GBA `.text` **9356 B**, with `vp_palettes` = **192 B**, 12 entries non-zero.
- **Measured after prototype:** **9248 B → 108 B saved (1.2%).** Table shrinks 192 B → 24 B; the
  extra loop costs back ~84 B.
- **Risk:** low, but the payoff scales with style-pair count, so on an app with fewer pairs it could
  be net-negative. Touches the same `vapor.h:110,117` ABI block as candidate 1, so the two should be
  sequenced, not developed in parallel. Also worth noting `PAL_BG[0] = vp_backdrop`
  (`vapor_gba.c:97`) runs after the copy and must keep doing so.
- **Parity verification:** the GBA rig compares per-cell palette banks after every press
  (`vapor/tests/parity.test.ts:161`, the `pals{i}` probe); suite must stay 71/71.

---

### Recommendation

**Candidate 1.** Largest measured saving (2172 B, 23–34% of ROM), the saving is already proven
byte-exact, GBA raw ROM size moves directly so the number is unambiguous, and the GBA parity rig
covers the exact surface. Candidate 2 is the same idea with a bigger absolute win but a metric that
needs explaining and a less predictable compiler; candidate 3 is small and should ride along with 1.

## 5. Reproducing everything here

```bash
export MGBA_PREFIX=/tmp/mgba-prefix
export CC65_LIB=/home/linuxbrew/.linuxbrew/share/cc65/lib/none.lib
bun install --frozen-lockfile

./findings/measure-artifact-size.sh runA && ./findings/measure-artifact-size.sh runB   # §2.1/§2.2
bun test vapor/tests/                                     # §1.1, expect 71/71

# §3 hotspots
arm-none-eabi-size -A /tmp/t405/runA/todo-gba/gen-gba/app.elf
arm-none-eabi-nm --print-size --size-sort --radix=d /tmp/t405/runA/todo-gba/gen-gba/app.elf | tail
```

## 6. Not measured / open

- **ESP32 and Playdate artifact sizes** — no SDK on this host. Both already use the compact 1bpp
  font, so candidates 1-2 do not apply to them; candidate 3 has an ESP32 analogue
  (`compile.ts:2453-2462` already emits sparse `vp_ink565`/`vp_paper565`), i.e. **ESP32 is already
  doing what candidate 3 proposes for GBA.**
- **Boot-time cost of the expansion loops** — not timed. Candidates 1-2 trade ROM for boot cycles;
  parity is frame-based and passed in prototype form, but no cycle count was taken.
- **`__divsi3`/`__udivsi3` = 540 B (5.8%) of the todo GBA ROM** — pulled in by `-lgcc` for 32-bit
  division. Whether the compiler emits division that could be strength-reduced was not investigated;
  it belongs to a codegen scout, not this one.
- **`main` = 568 B and `eff_1` = 424 B** — the largest code symbols. Effect-level redundancy is
  another scout's metric scope and was deliberately not pursued.
