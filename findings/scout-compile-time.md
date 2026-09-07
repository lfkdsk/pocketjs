# Scout: Pocket Vapor 编译耗时基线

Fleet task 407 · base commit `1b452c1a` · 只调查，不改动生产代码。

## 1. 环境

| 项 | 值 |
| --- | --- |
| CPU | Intel(R) Xeon(R) w5-3435X，32 逻辑核 |
| 内存 | 62 GiB total（采样时 ~28 GiB available） |
| OS | Linux 6.8.0-64-generic |
| Bun | 1.3.14（Linux x64 baseline） |
| typescript | 5.9.3（`node_modules/typescript/lib/typescript.js`，9 112 572 B） |
| 工具链 | `arm-none-eabi-gcc` / `sdcc` / `cc65`（linuxbrew） |
| `MGBA_PREFIX` | `/tmp/mgba-prefix` |

本 worktree 没有自己的 `node_modules`；测量时把它 symlink 到主 checkout
（`ln -s /var/tmp/oss/pocketjs/node_modules node_modules`），测完删掉，
`git status` 只剩 `findings/`，`git diff` 为空。这只影响模块解析，不进产物；
未加 symlink 时 `ts.ScriptTarget` 为 `undefined`，`compile.ts:209` 直接抛错。

测试基线未变：`bun test vapor/tests/` = **65 pass / 1 fail**，唯一红的是 NES parity
（`vapor/tests/parity.test.ts:156`，`ld65` 读 `none.lib` 报 `Read error at position 0`，
环境版本不匹配）。本报告的所有候选都**未跑 NES parity**。

## 2. 采样方法

三类测量分开做，因为它们的噪声来源不同：

1. **wall clock**：`date +%s%N` 前后取差，跑一次完整 `bun vapor/compiler/cli.ts …`。
   包含 Bun 启动、模块加载、编译、外部工具链。先 warmup 若干次（填满 page cache 与
   Bun 的 transpile cache），再连续采样。
2. **cold in-process**：每个样本一个新进程，只跑**一次** `compileVaporApp`，
   量的是真实 CLI 调用付的那一次（JIT 未热）。这是判断「编译器阶段成本」的主口径。
3. **warm in-process**：一个进程内 5 次 warmup + N 次采样，量的是算法成本
   （去掉 JIT 预热），用来看阶段占比。

离散度报 IQR 与 MAD（不报标准差：分布右偏，个别样本受调度抖动影响）。
依赖安装、外部 SDK 启动**不计入编译器耗时**——GBA 的 `arm-none-eabi-gcc`、
GB 的 `sdcc`、NES 的 `cc65` 都在 `buildRom` 内，报告中单列。

固定输入：

- `vapor/examples/todo/todo.tsx`（222 行）——主基准
- `vapor/examples/todo/todo.playdate.tsx`（228 行）
- `vapor/examples/playdate-six-button/playdate-six-button.tsx`——小输入对照

辅助脚本都放在 `/tmp/vapor-bench/`（仓库外，读-only 检查约束）：
`bench-inproc.ts`（warm 采样）、`cold-one.ts`（cold 单次）、`import-split.ts`
（模块加载归因）、`stats.py`（中位数/IQR/MAD）。第 6 节给出可直接重跑的命令。

## 3. 基线数字

### 3.1 端到端 wall clock（`todo.tsx`）

| 命令 | n | median | p25–p75 | IQR | MAD |
| --- | --- | --- | --- | --- | --- |
| `cli.ts check todo.tsx`（5 target 前端，无工具链） | 20 | **263 ms** | 260–270 | 10 | 5.5 |
| `cli.ts todo.tsx`（gba，含 `arm-none-eabi-gcc`） | 15 | **467 ms** | 459–472 | 13 | 6.0 |
| `cli.ts todo.tsx --target gb`（含 `sdcc` ×3） | 8 | **3 144 ms** | 3 111–3 152 | 41 | 25.5 |

### 3.2 一次 gba 全量构建的成分（同一进程内打点，n=3）

| 段 | ms |
| --- | --- |
| import `compile.ts` + `rom.ts` | 197.6 / 201.9 / 201.9 |
| 读入口文件 | 0.2–0.3 |
| `compileVaporApp`（cold） | 26.6 / 27.5 / 26.8 |
| `buildRom`（gcc + objcopy + 头部补丁） | 223.2 / 221.6 / 225.0 |

**编译器自身（前端 + 代码生成）只占一次 gba 构建的约 6 %。**
模块加载 ~200 ms 与外部工具链 ~223 ms 各占约 43 % / 48 %。

### 3.3 模块加载归因（n=10，每样本一个新进程，绝对路径避免 typescript 被实例化两次）

| 模块 | median ms |
| --- | --- |
| `typescript` | **190.5** |
| `vapor/compiler/styles.ts`（→ `framework/compiler/tailwind.ts`） | 7.8 |
| `vapor/compiler/rom.ts` | 4.35 |
| `vapor/compiler/font.gen.ts` | 1.6 |
| `vapor/compiler/compile.ts` 自身（2 476 行，已扣除依赖） | 1.7 |
| `vapor/compiler/boards.ts` | 0.0 |
| 合计 | 200.7 |

裸 Bun 启动（`bun -e '1'`）是 10 ms 量级，可忽略。
**启动噪声的实体是 9 MB 的 `typescript.js` 解析求值，不是 Bun 本身，也不是编译器源码规模。**

### 3.4 `compileVaporApp` 内部阶段

用 `/tmp/vapor-instr/` 下的 `compile.ts` 副本打点（生产文件未改）。打点位置对应
`compile.ts:209`（`ts.createSourceFile`）、`compile.ts:377-387`（module scan）、
`compile.ts:390`（`scanSetup`）、`compile.ts:391`（`emit`）。

**cold（每样本一新进程，n=8，取中位数）：**

| 阶段 | ms | 占比 |
| --- | --- | --- |
| `ts.createSourceFile` | 19.1 | **63 %** |
| module scan（`compile.ts:377-387`） | 1.03 | 3 % |
| `scanSetup`（`compile.ts:390`） | 4.44 | 15 % |
| `emit`（`compile.ts:2031`） | 4.72 | 16 % |
| 总 cold compile | 29.9（n=15，IQR 0.8，MAD 0.5） | |

**warm（同进程 20 warmup + 40 采样，n=4 组）：**

| 阶段 | median ms |
| --- | --- |
| `ts.createSourceFile` | 0.92 |
| module scan | 0.035 |
| `scanSetup` | 0.26 |
| `emit` | 0.42 |
| 总 | 1.83 |

warm 全 target（n=40 each）：gba 2.14 ms（IQR 0.71 / MAD 0.41）、gb 2.14（0.74 / 0.36）、
nes 1.94（0.71 / 0.38）、esp32 1.98（0.64 / 0.36）；
小输入 `playdate-six-button.tsx` 0.75 ms（IQR 0.22 / MAD 0.10）。

**结论：无论 cold 还是 warm，`ts.createSourceFile` 都是 `compileVaporApp` 里最大的单项
（cold 63 %、warm 50–57 %）。编译器自己写的那 2 476 行逻辑（scan + emit）加起来不到一半。**

### 3.5 `check` 路径的重复解析

`cli.ts:48-78` 对 5 个 target 各调一次 `compileVaporApp`，因此把同一份源码
解析了 5 遍。逐次 parse 耗时（n=5 组，同一进程内顺序）：

```
gba 25.4–30.8 ms | gb 4.1–4.7 | nes 3.1–3.4 | esp32 2.5–3.2 | playdate 2.3–2.6
```

第 1 次贵是 JIT 冷启，第 2–5 次合计 **12.4–13.5 ms**，是纯浪费。
5-target 段总 wall 45.5–49.7 ms（n=8）。

## 4. 候选优化（3 个，均未实施）

### C1 — `check` 复用一次已解析的 SourceFile

- **改哪**：`vapor/compiler/compile.ts:202-209`（`compileVaporApp` 签名与
  `ts.createSourceFile` 调用）+ `vapor/compiler/cli.ts:48-53`（5-target 循环）。
  给 `CompileOptions` 加一个可选 `sourceFile`，`cli.ts` 的 check 循环解析一次后传进去。
- **基线**：check 子命令 5-target 段 median 47.5 ms（n=8）；其中第 2–5 次 parse 合计 12.4–13.5 ms。
- **预期收益（已量，非估）**：在 `/tmp/vapor-instr/vapor/compiler/compile-proto.ts`
  原型上量到 5-target 段 47.5 ms → **37.3 ms**（−10.2 ms，−21 %）。
  对整条 `check` wall clock（263 ms）是 −4 %，因为 190 ms 的 typescript 加载不动。
- **风险**：低。`AppCompiler` 只读 AST（`compile.ts:376` 起遍历 `this.sf.statements`），
  各 target 的差异全在 `VAPOR_TARGETS[targetName]` 与 `StyleTable`，
  没有对 AST 的 mutation。**已验证**：原型下 5 个 target 生成的 C 哈希与状态-quo 逐一相同
  （`cf56e7cf251f735d / 69a8532cac97a9f6 / ac303966a38b37c5 / d4e71ec41b7d5b7 / c650b5946a90de54`）。
  唯一需要守的是「传入的 sourceFile 必须由同一 `fileName`/`source` 解析」——建议只在
  `cli.ts` 内部用，不进公开 API 语义。
- **parity 验证**：`bun test vapor/tests/`（GBA/GB/oracle 三路 parity 必绿）+
  新增用例：同一源码，`{sourceFile}` 路径与默认路径的 `app.c`/`app.graph`/`app.plan`
  对 5 个 target 逐一 `toBe` 相等（对应 `vapor/tests/compiler.test.ts:47-48` 已有的
  determinism 断言风格）。NES parity 环境红，不跑。

### C2 — 预编译 CLI 为 bytecode 产物，消掉 190 ms 的 typescript 加载

- **改哪**：不是改 `compile.ts` 的算法，而是加一条构建步骤（`package.json` scripts +
  `vapor/scripts/`）产出 `bun build --target=bun --bytecode` 的 CLI。
  阻碍点：`vapor/compiler/cli.ts:33` 的 top-level await 让 `--bytecode` 直接报
  `error: Unexpected .`——需要把 CLI 主体包进 `async function main()`。
- **基线**：模块加载 median 200.7 ms，其中 typescript 190.5 ms（第 3.3 节）。
- **预期收益（已量）**：
  - 只 import `compile.ts`：源码 187.3 ms → bundle 155.2 ms → **bytecode 62.3 ms**（−67 %）。
  - `check` 等价入口端到端：**300 ms → 156 ms**（n=12 each，IQR 5 / 4），输出 `diff` 逐字节相同。
  - gba 全量构建等价入口端到端：**506 ms → 363.5 ms**（n=10 each，IQR 9 / 3），
    产物 `todo.gba` `cmp` 逐字节相同。
  - 加载 bytecode 的 `compile.ts` 与源码版对 gba/gb/nes/esp32 生成的
    `c`/`graph`/`plan` 全部相同（`ALL_IDENTICAL true`）。
- **风险**：中。`.jsc` 有 32 MB（源码 bundle 8.9 MB），要进 gitignore 并由构建步骤生成，
  否则版本漂移会让产物与源码不一致。`boards.ts:14` / `rom.ts:19` /
  `esp32.ts:15` / `playdate.ts:13` 都用 `import.meta.dir` 定位 `vapor/runtime`
  与 `vapor/boards`，bundle 落在别处会解析失败（`--compile` 单文件二进制直接
  `ENOENT: scandir '/$bunfs/boards'`）——所以产物必须落在 `vapor/compiler/` 下，
  或把这些路径改成显式可配置。**它不改编译逻辑，parity 风险最低，工程风险最高。**
- **parity 验证**：`bun test vapor/tests/` 走源码路径不受影响；另加一条用例，
  对同一输入比对 bytecode CLI 与源码 CLI 的产物字节（`cmp`）与 `check` 输出（`diff`）。
  NES parity 环境红，不跑。

### C3 — GB / NES 的三个 translation unit 并行编译

- **改哪**：`vapor/compiler/rom.ts:157-163`（GB 的 `for … await $\`sdcc …\``）与
  `vapor/compiler/rom.ts:251-261`（NES 的 `cc65` + `ca65` 串行循环）。
- **基线（已量）**：GB 三个 unit 串行 2 816–2 828 ms（`vapor_core` 341–347、
  `vapor_gb` 859–864、`gen_app` 1 613–1 617）；NES 串行 25–26 ms。
- **预期收益（已量）**：GB **2 828 → 1 613 ms**（−43 %），把整条
  `--target gb` wall clock 从 3 144 ms 拉到 ~1 930 ms（−39 %）。
  NES 26 → 13 ms（绝对值小，不值得单独动）。
  **已验证**：GB 三个 `.rel` 串行与并行产物 `cmp` 逐字节相同。
- **风险**：低到中。三个 unit 无编译期依赖，输出文件名互不相同。
  NES 一侧并行后 `.o` 会**不相同**——因为 ca65 把输入 `.s` 的路径写进目标文件
  （`cmp -l` 差异位置对应嵌入的 `p_` 前缀路径；`.s` 本身逐字节相同）。
  这说明并行化本身安全，但验证时要比 `.s` 或最终 ROM，不能比 `.o`。
  另一个风险是并发进程数：这里只有 3 个，不会挤爆 CI。
- **parity 验证**：GB parity 用例（`vapor/tests/parity.test.ts`）就是最直接的验收——
  它跑真 ROM。再加一条：同一输入串行/并行两条路径产出的 `todo.gb` `cmp` 相等。
  NES parity 环境红，只能比 `.s` 与 `gen_app.o` 之外的中间产物。

## 5. 未选入的观察

- `styles.ts` 的模块加载 7.8 ms 里大部分来自 `framework/compiler/tailwind.ts`
  （`styles.ts:27`）的调色板表；相对 190 ms 的 typescript 不值得动。
- `ts.createSourceFile` 的 `setParentNodes=true`（`compile.ts:209`）warm 下比 `false`
  贵 0.30–0.36 ms（1.29–1.46 vs 0.99–1.18，n=30）。cold 下两者都被 JIT 支配（23–27 ms），
  差异测不出来。收益太小且需要审计所有 `.parent` 用法，不列为候选。
- `bun test vapor/tests/` 总 wall 4.5–5.1 s，其中 3.57 s 是那一个失败的 NES parity 用例。
  测试耗时的主体是外部工具链，不是编译器。

## 6. 重跑命令

前置（本 worktree 需要）：

```bash
cd /home/tangollvm/.fleet/worktrees/task-407
ln -sfn /var/tmp/oss/pocketjs/node_modules node_modules
export MGBA_PREFIX=/tmp/mgba-prefix
```

wall clock（第 3.1 节）：

```bash
ms(){ s=$(date +%s%N); "$@" >/dev/null 2>&1; e=$(date +%s%N); echo $(( (e-s)/1000000 )); }
for i in 1 2 3; do ms bun vapor/compiler/cli.ts check vapor/examples/todo/todo.tsx >/dev/null; done   # warmup
for i in $(seq 1 20); do ms bun vapor/compiler/cli.ts check vapor/examples/todo/todo.tsx; done | python3 /tmp/vapor-bench/stats.py
for i in $(seq 1 15); do ms bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx --out /tmp/vapor-bench/fA; done | python3 /tmp/vapor-bench/stats.py
for i in $(seq 1 8);  do ms bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx --target gb --out /tmp/vapor-bench/fB; done | python3 /tmp/vapor-bench/stats.py
```

cold 单次编译（第 3.4 节主口径）与 warm 阶段占比：

```bash
for i in $(seq 1 15); do bun /tmp/vapor-bench/cold-one.ts "$PWD" gba "$PWD/vapor/examples/todo/todo.tsx"; done | python3 /tmp/vapor-bench/stats.py
bun /tmp/vapor-bench/bench-inproc.ts "$PWD" vapor/examples/todo/todo.tsx gba 5 40
```

模块加载归因（第 3.3 节）：

```bash
for i in $(seq 1 10); do bun /tmp/vapor-bench/import-split.ts "$PWD"; done
```

阶段打点（第 3.4 节）需要 `/tmp/vapor-instr/` 下的插桩副本；C1 原型在
`/tmp/vapor-instr/vapor/compiler/compile-proto.ts`，C2 的 bytecode 入口在
`/tmp/vapor-bc-tree/`。这些都在仓库外，重跑前需按第 2 节重建。

## 7. 给下游的排序建议

按「已量到的收益 / 风险」：

1. **C3**（GB 并行）：−1 215 ms，占比最大，改动 8 行，产物已证明逐字节相同。
2. **C1**（check 单次解析）：−10.2 ms，改动最小，输出哈希已证明相同。
3. **C2**（bytecode）：−144 ms，收益不小但引入构建产物与路径解析两个工程问题。

C3 与 C1 互不冲突，可分两个任务并行推进（C3 只碰 `rom.ts`，C1 只碰
`compile.ts` 签名与 `cli.ts`）。C2 依赖先把 `cli.ts` 的 top-level await 重构掉，
建议单独立项。
