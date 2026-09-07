# GB 构建：三个 sdcc translation unit 并行化（task 440，base_task 407）

## 1. 改了什么

`vapor/compiler/rom.ts` 的 `buildGbRom`，只有这一处：原先 `for … await sdcc -c` 串行编译
`vapor_core.c` / `vapor_gb.c` / `gen_app.c`，改为 `Promise.allSettled` 一次派发三个 sdcc 进程。
三者无编译期依赖、`-o` 输出名互异，`cflags` 逐字未变。

GBA、NES、ESP32、Playdate 的构建路径未改动（diff hunk 只落在 `buildGbRom` 与一行 `import { rm }`）。
Vapor 编译语义（`compile.ts`）未改动。

随并行化一并处理的两个正确性问题：

- **失败传播**：`Promise.allSettled` 不会自己抛。收集所有非零退出，按 units 声明顺序（= 链接顺序）
  报第一个失败单元，附带其余失败单元名，并把 sdcc 的 stderr 拼进 message。
  用 `.nothrow()` 而不是让 `$` 自己抛，是因为 `.quiet()` 下 Bun 的 `ShellError.message` 只有
  `Failed with exit code 1`，拿不到 sdcc 的诊断——串行版本靠 `$` 默认抛出时把 stderr 打到终端，
  并行版本必须显式取回，否则日志可诊断性反而变差。
- **陈旧产物**：并行前先 `rm -f` 三个目标 `.rel`。串行版本里某个单元失败会立刻中断整个构建，
  上一次构建留下的 `.rel` 不会被误用；但任何「失败后继续」的结构都需要这一步，因为
  `sdcc … -o app.ihx` 的链接调用无法区分本次产物与上一次的残留。

## 2. 环境

| 项 | 值 |
| --- | --- |
| worktree | `/home/tangollvm/.fleet/worktrees/task-440`，分支 `fleet/93f58b98a624/task-440` |
| base commit | `59548d4` |
| 机器 | Linux 6.8.0-64-generic，`nproc` = 32，62 GB RAM |
| sdcc | 4.6.0 #16555 (Linux)，linuxbrew |
| bun | 1.3.14 (d1632b29) |
| `MGBA_PREFIX` | `/tmp/mgba-prefix` |
| `CC65_LIB` | `/home/linuxbrew/.linuxbrew/Cellar/cc65/2.19/share/cc65/lib/none.lib` |
| 固定输入 | `vapor/examples/todo/todo.tsx`，`--target gb` |

并行度是隐式的 3（三个单元全部同时派发），没有引入 job 上限。32 逻辑核上 3 个进程不构成压力；
若将来单元数增长到与核数同量级，需要显式限流。

## 3. 端到端 wall clock（`bun vapor/compiler/cli.ts … --target gb`）

预热：每次测量前先跑 3 次同一命令丢弃结果。计时用 `date +%s%N` 包住整条 CLI 调用，
非零退出即中止（不会把失败样本计入）。n=15。脚本 `/tmp/t440/bench.sh`。

| | n | median | Q1 | Q3 | IQR | min | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 串行（HEAD `59548d4`） | 15 | **3 108 ms** | 3 096 | 3 114 | 18 | 3 073 | 3 150 |
| 并行（本次改动） | 15 | **1 847 ms** | 1 837 | 1 867.5 | 30.5 | 1 817 | 1 882 |

**median −1 261 ms，−40.6 %。** 两组区间不重叠（串行 min 3 073 > 并行 max 1 882）。

原始样本（ms，升序）：

```
串行  3073 3086 3090 3096 3096 3098 3107 3108 3112 3113 3113 3115 3131 3142 3150
并行  1817 1826 1835 1837 1837 1844 1846 1847 1855 1866 1866 1869 1872 1873 1882
```

## 4. 三单元阶段单独计时

把三条 sdcc 调用从构建里摘出来直接在 shell 里跑（`cflags` 与 `buildGbRom` 一致：
`-msm83 --opt-code-size -DVP_GRID_W=20 -DVP_GRID_H=18 -DVP_STR_CAP=24 -DVP_VIEW_CAP=32`），
`gen_app.c` 用一次真实构建产出的那份。预热 2 次，n=15。

| | n | median | Q1 | Q3 | IQR | min | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 串行三单元 | 15 | **2 721 ms** | 2 715.5 | 2 734.5 | 19 | 2 686 | 2 744 |
| 并行三单元 | 15 | **1 592 ms** | 1 581 | 1 617.5 | 36.5 | 1 554 | 1 627 |

**−1 129 ms，−41.5 %**，与 base_task 407 的 2 828 → 1 613 ms（−43 %）一致。
并行 median 1 592 ms 接近最慢单元 `gen_app`（407 实测 1 613–1 617 ms）单独耗时，
说明这一阶段现在由最长单元支配，没有额外调度开销。

同一次运行里 `cmp` 串行与并行产出的三个 `.rel`：全部逐字节相同。

## 5. 产物逐字节比较

串行基线产物（HEAD `59548d4` 构建）保存在 `/tmp/t440/base`。并行版本连续构建 5 次，
每次对 5 个文件 `cmp`：

```
run1: all 3 .rel + crt0.rel + todo.gb byte-identical to serial baseline
run2: all 3 .rel + crt0.rel + todo.gb byte-identical to serial baseline
run3: all 3 .rel + crt0.rel + todo.gb byte-identical to serial baseline
run4: all 3 .rel + crt0.rel + todo.gb byte-identical to serial baseline
run5: all 3 .rel + crt0.rel + todo.gb byte-identical to serial baseline
```

比较的文件：`gen-gb/vapor_core.rel`、`gen-gb/vapor_gb.rel`、`gen-gb/gen_app.rel`、
`gen-gb/crt0.rel`、`todo.gb`。额外 `cmp` 中间产物 `gen-gb/app.ihx` 也相同。
`todo.gb` 两侧均为 32 768 B。**5 次重复全部相同，产物不因调度顺序而变。**

（对照 407 的观察：NES 一侧的 `.o` 并行后**不**相同，因为 ca65 把输入路径写进目标文件。
GB 的 sdcc `.rel` 没有这个问题——这也是本任务只动 GB 的一个理由。）

## 6. 测试

新增 `vapor/tests/gb-build.test.ts`（6 个用例）与两个夹具：

- `vapor/tests/harness/sdcc_shim.sh`：冒充 `sdcc`，记录每次调用的开始/结束毫秒时间戳，
  可按源文件名注入失败（`VP_SDCC_FAIL`），可只 touch `-o` 不真编译（`VP_SDCC_STUB`）。
  stub 写入的是**非法** `.rel` 内容，这样「本不该发生的链接」会响亮失败而不是静默通过。
- `vapor/tests/harness/gb_build_runner.ts`：在子进程里跑一次 `buildGbRom`，打印一行 JSON。
  必须走子进程：Bun 的 `$` 在进程启动时解析 PATH，测试内改 `process.env.PATH` 对 `$` 无效
  （实测 `which sdcc` 返回 shim 路径，但 `$\`sdcc --version\`` 仍执行真 sdcc）。

用例与它们各自锁住的行为：

| 用例 | 锁住什么 |
| --- | --- |
| three units overlap in time | 三个单元真的并发（每个 sleep 400 ms，断言 `max(start) < min(end)`） |
| a failure in `vapor_core.c` / `vapor_gb.c` / `gen_app.c` … ×3 | 任一单元失败 → 构建失败、message 含该 `.rel` 名与 `target gb`、含 sdcc 原始 stderr、失败单元无 `.rel`、无 ROM 落盘 |
| stale `.rel` not linked | 先成功构建一次，再让 `gen_app.c` 失败，断言上一次的 `gen_app.rel` 已不存在（不会被误链） |
| all three failing at once | 报告顺序确定（按链接顺序报 `vapor_core.rel`，并列出其余两个） |

### 6.1 全量套件

```
export MGBA_PREFIX=/tmp/mgba-prefix
export CC65_LIB=/home/linuxbrew/.linuxbrew/Cellar/cc65/2.19/share/cc65/lib/none.lib
bun test vapor/tests/
→ 77 pass, 0 fail, 7426 expect() calls, 8 files, 12.91 s
```

基线核对：把 `rom.ts` 换回 HEAD 版本并移出新测试文件，同样环境下 **71 pass / 0 fail**。
71 + 6 = 77，无回归、无用例被跳过。

### 6.2 parity

`bun test vapor/tests/parity.test.ts` → **6 pass / 0 fail**，用例名逐条确认：
`gba:` 渲染 + tripwires、`gb:` 渲染 + tripwires、`nes:` 渲染 + tripwires，全部在
`oracle == device, three consoles` 之下（oracle 即比较基准）。

**NES parity 在本机是绿的**，与项目上下文里「本机基线 65/66、NES 必红」的说法不同。原因是
`rom.ts:20` 的默认值 `/opt/homebrew/share/cc65/lib/none.lib` 是 macOS 路径，本机不存在；
显式设 `CC65_LIB=/home/linuxbrew/.linuxbrew/Cellar/cc65/2.19/share/cc65/lib/none.lib`
（与 `ld65` 同属 cc65 2.19 那份 Cellar）后 NES parity 通过。不设该变量时复现出上下文描述的红：
`0 pass / 1 fail`。即那个红是 `CC65_LIB` 未设导致，不是 ld65 V2.18 与库版本不匹配。
未改动任何环境。

### 6.3 变异测试（确认新用例有牙）

每次只改 `rom.ts` 一处，跑 `bun test vapor/tests/gb-build.test.ts`，之后还原：

| 变异 | 结果 |
| --- | --- |
| A：改回串行 `for … await` 循环 | **5 pass / 1 fail** — 恰好 `three units overlap in time` 失败 |
| B：`if (failures.length > 0)` → `if (false)`（吞掉失败） | **2 pass / 4 fail** — 三个单元失败传播用例 + 报告顺序用例全失败 |
| C：删掉并行前的 `rm` 陈旧 `.rel` | **5 pass / 1 fail** — 恰好 `stale .rel not linked` 失败 |

三个变异各被对应用例抓住，且只被对应用例抓住。还原后 `git diff --stat` 回到 41 insertions / 3 deletions。

## 7. 没量到 / 不在范围

- **NES 并行未做**：407 实测 NES 三单元串行仅 25–26 ms，绝对收益太小；且 ca65 会把输入路径
  写入 `.o`，并行后 `.o` 不逐字节相同，验证口径需另立。本任务按 scope 未触碰。
- 未测量多个 GB 构建同时进行时的表现（例如并行跑多个 target 的 CI）。当前实现每次 GB 构建
  固定派发 3 个 sdcc，没有全局 job 预算；若外层也并行，进程数会相乘。
- 未测量 CPU 时间变化。`user` 时间在冒烟运行里 3.153 s → 3.022 s，同量级，但 n=1 不作结论。

## 8. 重跑命令

```bash
cd /home/tangollvm/.fleet/worktrees/task-440
ln -sfn /var/tmp/oss/pocketjs/node_modules node_modules
export MGBA_PREFIX=/tmp/mgba-prefix
export CC65_LIB=/home/linuxbrew/.linuxbrew/Cellar/cc65/2.19/share/cc65/lib/none.lib

bun test vapor/tests/                      # 77 pass
bun test vapor/tests/gb-build.test.ts      # 6 pass

# wall clock（预热 3 次后 n=15）
ms(){ s=$(date +%s%N); "$@" >/dev/null 2>&1; e=$(date +%s%N); echo $(( (e-s)/1000000 )); }
for i in 1 2 3; do ms bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx --target gb --out /tmp/gbbench >/dev/null; done
for i in $(seq 1 15); do ms bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx --target gb --out /tmp/gbbench; done

# 与串行产物比字节：先在 HEAD 上构建到 /tmp/base，再在本分支构建到 /tmp/par
cmp /tmp/base/gen-gb/gen_app.rel /tmp/par/gen-gb/gen_app.rel && cmp /tmp/base/todo.gb /tmp/par/todo.gb
```
