# Scout: Pocket Vapor memory plan — RAM baselines and optimization candidates

Investigation only. No production code was changed; every measurement below was
taken either from the unmodified compiler or from hand-edited copies of the
*generated* C under `/tmp/t406/`.

Base commit: `1b452c1a9864b5122f65c5c117da9a4f18cf30c7`
(`feat(vapor): overlay allocation for frame-local temporaries`).

## 1. Measurement environment

| | |
|---|---|
| Host | Linux 6.8.0-64-generic, x86_64 |
| Bun | 1.3.14 |
| GBA cc | `arm-none-eabi-gcc` (linuxbrew) |
| GB cc | `sdcc -msm83` (linuxbrew) |
| NES cc | `cc65` (linuxbrew) |
| Env | `export MGBA_PREFIX=/tmp/mgba-prefix` |

The worktree has no `node_modules`; the compiler needs `typescript` from the
main checkout. Before any command below:

```
ln -s /var/tmp/oss/pocketjs/node_modules node_modules   # gitignored, not a source change
export MGBA_PREFIX=/tmp/mgba-prefix
```

Test-suite baseline on this machine, unchanged from the documented state:

```
$ bun test vapor/tests/
 65 pass
 1 fail        # vapor/tests/parity.test.ts:156 — NES: ld65 cannot read none.lib
 229 expect() calls
Ran 66 tests across 7 files. [4.68s]
```

**NES parity was not run.** The `ld65`/`none.lib` version mismatch is a
pre-existing environment fault, out of scope. GBA, GB and oracle parity are
green. NES claims below are C-layer and linker-map only.

Compiler wall time is not a bottleneck for this work — three consecutive runs of
`bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx --target gba` measured
0.47 s / 0.46 s / 0.47 s.

## 2. Where the three numbers come from

All four plan lines are assembled in one place, `vapor/compiler/compile.ts:2326`:

```
state RAM:        vapor/compiler/compile.ts:2303-2315   (poolBytes, viewBytes, scalarBytes)
overlay RAM:      vapor/compiler/compile.ts:343         (slotBytes, accumulated in ovlAssign)
reactive tables:  vapor/compiler/compile.ts:2329        (refs / computeds / effects counts)
ROM data:         vapor/compiler/compile.ts:2316-2325
```

The consuming side: `vapor/compiler/compile.ts:2184-2189` emits the actual state
declarations, `:2176-2181` emits the record structs, `:2159` emits
`#define VP_VIEW_CAP <poolCap>`, and `vapor/runtime/vapor.h:48-58` defines
`vp_sb` / `vp_view` against those defines. `vapor/tests/overlay.test.ts:28` is
the only test that asserts a plan line (the NES overlay figure).

## 3. Baselines: memory plan, all inputs × targets

Command shape (`<target>` ∈ gba, gb, nes, esp32, playdate):

```
bun vapor/compiler/cli.ts <entry> --target <target> --out /tmp/t406/<target>
```

`vapor/examples/todo/todo.tsx`:

| target | state RAM (scalars + pools + views) | overlay RAM | reactive tables |
|---|---|---|---|
| gba | 41 + 833 + 66 = **940 B** | 83 B / 3 slots / 8 temps | 6 dirty, 5 valid, 4 effects |
| gb | 41 + 833 + 66 = **940 B** | 83 B / 3 slots / 8 temps | 6 dirty, 5 valid, 4 effects |
| nes | 37 + 177 + 18 = **232 B** | 51 B / 3 slots / 8 temps | 6 dirty, 5 valid, 4 effects |
| esp32 | 41 + 833 + 66 = **940 B** | 83 B / 3 slots / 8 temps | 6 dirty, 5 valid, 4 effects |

`vapor/examples/todo/todo.playdate.tsx`, target playdate:
45 + 833 + 66 = **944 B** state, 83 B / 3 slots / 8 temps overlay,
**7 dirty, 5 valid, 4 effects** (the extra ref is the axis accumulator).

`vapor/examples/playdate-six-button/playdate-six-button.tsx` (gba and playdate
both): 12 + 0 + 0 = **12 B** state, **0 B overlay**, 3 dirty / 1 valid / 3 effects.
This input exercises no pool, no view and no overlay — it is the negative control
for all three candidates.

Artifacts: `todo.gba` 9356 B, `todo.gb` 32768 B (fixed 32 KB ROM-only cart).
NES and ESP32 artifacts cannot be linked here (`none.lib`, and no ESP-IDF at
`~/Library/Caches/esp-idf/v6.0.2/export.sh`), but their C and memory plans
generate fine.

## 4. Key layout detail: the plan and the linker disagree

The plan's per-record size at `vapor/compiler/compile.ts:2307` sums field sizes
as `str→strCap+1`, `bool→1`, `num→4` with **no alignment or padding model**. For
GBA todo this happens to be exact — `rec_todo` is `{vp_sb text; u8 done;}`,
26 B by the formula and 26 B in the ELF:

```
$ arm-none-eabi-nm -S /tmp/t406/gba/gen-gba/app.elf | grep g_todos
... 00000340 b g_todos          # 832 = 26 × 32 ✓
```

Full app-owned `.bss` for GBA todo (`arm-none-eabi-nm -S`, sizes in bytes):

```
g_todos 832   c_filtered_v 33   c_visible_v 33   ovl_view0 33
g_draft 25    ovl_sb0 25        ovl_sb1 25
g_cursor/g_filter/g_editing/g_glyph 4 each   c_current_v/c_remaining_v/c_scroll_v 4 each
vp_dirty 4    c_valid 4         g_todos_len 1
--- runtime-owned, NOT in the plan ---
vp_grid_ch 600   vp_grid_pal 600   vp_ln 30   vp_rows_dirty 4   vp_tripwires 1
total .bss = 2284 B   (arm-none-eabi-size app.elf)
```

Two structural facts fall out:

1. **The plan reports ~41 % of the linked RAM.** The 940 B it prints excludes the
   1200 B twin cell grids (`vapor/runtime/gba/vapor_gba.c:31-32`) and the 30 B
   line scratch (`vapor/runtime/vapor_core.c:48`). That is correct as an
   *app-state* figure, but a reader budgeting a 32 KB IWRAM gets no signal from
   it. Not a defect to fix; noted so candidates are not mis-sized.
2. **`c_visible_v` is 33 B even though the compiler proved its bound is 12.**
   The reactive graph prints `visible: view(maxLen 12)`, and
   `vapor/compiler/compile.ts:914-932` computes that bound — but `:2159` defines
   one global `VP_VIEW_CAP = poolCap` and every `vp_view` uses it. Candidate B.

## 5. Candidates

Three, ranked by verified saving per unit of risk.

### A. Order record fields by descending alignment (highest confidence)

**Where.** `vapor/compiler/compile.ts:2176-2181` emits `rec_<iface>` fields in
source-declaration order. `:2307` computes the plan's record size with no
padding term. Both must change together or the plan and the ELF diverge further.

**The waste.** A `vp_sb` is `{u8 len; char b[N];}` — alignment 1, size 25 (GBA).
Put a `s32` after it and ARM inserts 3 bytes of padding, then tail-pads the whole
record to a multiple of 4. Measured with `arm-none-eabi-gcc -O2`:

```
struct { vp_sb text; s32 pri; u8 done; }   sizeof = 36      # as emitted today
struct { s32 pri; u8 done; vp_sb text; }   sizeof = 32      # descending alignment
```

**Baseline case with numbers.** Probe `/tmp/t406/probe/pad.tsx` — an
`interface Item { text: string; pri: number; done: boolean }` pool plus one
cursor ref and one `.length` computed:

```
plan says:  state RAM: 4 B scalars/strings + 961 B pools + 0 B computed views
ELF says:   g_items = 1152 B   (36 × 32, not the planned 30 × 32 = 960)
            .bss = 2408 B
```

Hand-reordering only the `typedef` in the generated C and re-linking with the
exact `rom.ts:135` command line:

```
g_items = 1024 B   (32 × 32)
.bss = 2280 B      →  128 B saved, text unchanged at 5924 B
```

**Expected benefit.** 128 B of RAM (5.3 % of `.bss`) on that probe; 0 B on both
shipped examples — `rec_todo` has no `s32` field, so today's pool is already
optimal. This is a latent cost that bites the first app mixing a string and a
number in one record, which is the ordinary shape.

**Constraints.** ARM and Xtensa only. `sdcc -msm83` and `cc65` pack tightly —
the same struct is 26 B under both (`sdcc -msm83 -c`: `A _DATA size 1A`;
`cc65 -t none`: `_probe: .res 26,$00`), so GB and NES see no change either way.
Field order is not observable from app code: `vapor/compiler/compile.ts:2093`
seeds by field name, and record access is by name everywhere except the u16
pointer arithmetic at `:171` of the generated C, which indexes whole records.

**Risks.** Low. The one real hazard is the debug block: `:2129-2145` walks refs,
not record fields, so the parity receipt layout is unaffected — worth an
assertion, not a redesign. Reordering must be a *stable* sort by descending
alignment so output stays deterministic for
`compiler.test.ts`'s golden-C checks.

**Parity verification.** `bun test vapor/tests/` (expect 65/66); GBA and GB
parity are the ones that can move, and both read records by field. Add a
compiler test asserting the emitted field order and the plan's record size for a
mixed `{string, number, boolean}` interface, and assert the six-button example's
plan is byte-identical (no pool → no change).

### B. Size each view slot by its proven `maxLen`

**Where.** `vapor/compiler/compile.ts:2159` emits one `#define VP_VIEW_CAP
<poolCap>`; `vapor/runtime/vapor.h:56-58` sizes `vp_view` from it; `:833` and
`:343` declare view statics and overlay view slots at that single size. The
per-view bound already exists and is already printed —
`vapor/compiler/compile.ts:914-932` (`viewMaxLen`), reported at `:2275`.

**The waste.** GBA todo has two view computeds. `filtered` is genuinely
`maxLen 32`. `visible` is `filtered.value.slice(scroll, scroll + WINDOW)` with
`WINDOW = 12` — proven bound 12, allocated 33 B.

**Baseline case with numbers.** Substituting a 13-byte view type for
`c_visible_v` in the generated GBA todo C and re-linking:

```
before:  .bss 2284 B, text 9356 B
after:   .bss 2264 B, text 9348 B      →  20 B RAM, 8 B ROM
```

(The probe aliases a 13-byte object through a `vp_view *`, so gcc emits
`-Warray-bounds` notes; the real change would give each view its own type and
propagate it through accessor signatures, which is exactly why this candidate is
more invasive than A.)

**Expected benefit.** 20 B on GBA/GB/ESP32 todo (2.1 % of the 940 B plan
figure), and the plan's `viewBytes` line at `:2311` becomes truthful instead of
`count × (poolCap + 1)`. Scales with how much an app windows its lists — a 50×30
Playdate app slicing a 32-entry pool into a 6-row panel would save 26 B per such
view.

**Constraints.** `vp_view` is a single named type in the shared runtime header,
and `vapor_core.c` takes `const vp_sb *` but never a `vp_view *` — the type is
generated-code-only, which makes this tractable. Every accessor return type,
every `const vp_view *vN;` local (`:1089`), and the overlay slot coloring at
`:334-346` would need the per-view size. Overlay slots must take the **max** of
the bounds of the temps they host, or a wide temp lands in a narrow slot.
`viewMaxLen` returns `poolCap` on every path it cannot prove (`:932`), so the
default stays safe.

**Risks.** Medium — the highest of the three. A wrong bound is a silent buffer
overrun into adjacent state, not a tripwire: the fill loops at `:1009` write
`v.idx[v.len++]` with no capacity guard, relying on the bound being sound.
`viewMaxLen`'s `sliceWindow` (`:920-923`) is the load-bearing piece. Mitigation:
size slots at `max(bound, …)` and keep `VP_TRIP_VIEW_FULL`
(`vapor/runtime/vapor.h:80`) meaningful by emitting a debug-build assertion.

**Parity verification.** Full `bun test vapor/tests/`. Then adversarial inputs:
a conditional view where the branches have different bounds (`viewMaxLen` takes
the max at `:916-917` — assert that), a view of a view, a `slice` with
non-constant window, and a `push` past the narrower bound to confirm the
tripwire still fires rather than corrupting neighbours. `overlay.test.ts:28`'s
NES figure will change and must be re-derived by hand, not just re-recorded.

### C. Do not materialize a view for `filter(...).length`

**Where.** The overlay temp for a view chain is allocated whenever the chain is
materialized; `remaining = computed(() => todos.value.filter(t => !t.done).length)`
(`vapor/examples/todo/todo.tsx:124`) lowers to a full index fill followed by
reading `.len`. Generated GBA todo, `/tmp/t406/gba/gen-gba/gen_app.c:87-93`:

```c
{ u8 i5; ovl_view0.len = 0;
  for (i5 = 0; i5 < g_todos_len; i5++) {
    rec_todo *p6 = g_todos + (u16)(i5);
    if (!p6->done) ovl_view0.idx[ovl_view0.len++] = i5;
  }
}
c_remaining_v = (s32)ovl_view0.len;
```

The `idx[]` writes are dead: only `.len` is read. The emission site is the view
fill helper at `vapor/compiler/compile.ts:1009` (`/** Emit statements filling
target (a vp_view lvalue) from a view expr. */`), reached for `.length` with no
special case.

**Baseline case with numbers.** Probe `/tmp/t406/probe/count.tsx` — one pool, one
`filter(...).length` computed, one cursor ref:

```
plan says:  state RAM 4 + 833 + 0 B;  overlay RAM: 33 B in 1 shared slots (1 temp)
ELF says:   .bss 2120 B, text 6012 B
```

Replacing the fill with a `u8` counter in the generated C and re-linking
(`-Werror` clean):

```
.bss 2088 B, text 5976 B      →  32 B RAM and 36 B ROM
```

**Expected benefit.** 32 B of RAM and 36 B of ROM per app whose *only* view
temps are counts. On shipped GBA todo the saving is **0 B** and must be reported
as such: `ovl_view0` also hosts the two whole-list compaction temps
(`gen_app.c:165-172`, `:186-193`), so the slot survives — the plan's overlay
line would stay `83 B in 3 shared slots` and drop to `7 frame-local temps`.
The win is real but conditional on the app.

**Constraints.** Applies to a chain ending in `.length` whose intermediate
indices are read by nobody. `filter(...).length` and
`slice(a,b).length` fold to a counter; `filter(...)[i].length` does not. Because
the temp count feeds overlay coloring at `:334-346`, removing a temp can only
shrink or leave the slot set — it cannot force a new slot.

**Risks.** Low-medium. Predicate side effects would be the classic hazard, but
the subset forbids them (no closures escaping setup, no assignment in a filter
predicate — `vapor/DESIGN.md` §4 "Out"), so a counter and a fill visit the same
elements in the same order. `VP_TRIP_VIEW_FULL` currently fires when a count
exceeds `poolCap`; a counter cannot overflow that way, which is a *behavior*
change in the tripwire byte the debug block exports. That must be preserved or
consciously dropped, and the parity receipt reads `vp_tripwires`
(`vapor/runtime/gba/vapor_gba.c:76`).

**Parity verification.** `bun test vapor/tests/` — GBA and GB parity read
`remaining` on the header row every frame, so a miscount fails cell-for-cell
immediately. Add: a compiler test that the counted form emits no `idx[` write
for a count-only app and that its overlay plan line loses one temp; an oracle
test with an empty list, an all-done list, and a list at `poolCap`; and a test
that `filter(...)[0].text` still materializes.

## 6. Recommendation

**A** is the one to build first: verified 128 B on a probe, zero measured risk on
the shipped examples, and it fixes a plan/ELF divergence rather than trading one
number against another. **C** is the cheapest to implement but its benefit on the
demo app is 0 B. **B** has the most upside on real windowed UIs and the most
downside if `viewMaxLen` is ever wrong — it wants its own task with an
adversarial-input budget.

## 7. Reproducing this report

```
ln -s /var/tmp/oss/pocketjs/node_modules node_modules
export MGBA_PREFIX=/tmp/mgba-prefix

# §3 baselines
for t in gba gb nes esp32; do
  bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx --target $t --out /tmp/t406/$t 2>/dev/null \
    | grep -A5 "memory plan"
done
bun vapor/compiler/cli.ts vapor/examples/todo/todo.playdate.tsx --target playdate --out /tmp/t406/pd
bun vapor/compiler/cli.ts vapor/examples/playdate-six-button/playdate-six-button.tsx --target gba --out /tmp/t406/sb

# §4 linked RAM (GBA is the only target that links on this machine)
arm-none-eabi-size /tmp/t406/gba/gen-gba/app.elf
arm-none-eabi-nm -S /tmp/t406/gba/gen-gba/app.elf | grep -iE " [bB] "

# §1 test baseline
bun test vapor/tests/
```

Probe sources and the hand-edited generated C are under `/tmp/t406/probe/`
(scratch, not committed). Re-linking a hand-edited `gen_app.c` uses the exact
command line from `vapor/compiler/rom.ts:135`.
