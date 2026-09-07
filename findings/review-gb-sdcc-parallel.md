# GB sdcc 三单元并行编译审核（task 447，review task 440）

## 结论

任务 440 的优化结论为 **Qualified Pass**。在同一台 32 逻辑核 Linux 主机、同一 SDCC 4.6.0
和同一 Todo 输入下，我独立复测到父提交串行 median 3,066 ms，修正后的并行版本 median
1,828 ms，减少 1,238 ms（**-40.4%**）。这复现了报告的收益量级，但不是精确的 -40.6%；
首次未加审核修正的并行样本为 1,844 ms（-39.9%），说明百分比会随测量时段小幅变化。

成功构建的三个 C translation unit、crt0、IHX 和最终 ROM 在连续 5 次并行构建中都与父提交
串行产物逐字节相同。真实 SDCC 时间线证明三个编译重叠，而且链接在最慢编译结束后才启动。
故障注入证明所有子进程都被等待，任一或多个单元失败都会阻止链接并按固定 link order 报错。

审核发现并修正了任务 440 测试没有覆盖的四个失败路径：SDCC 非零退出前留下部分 .rel、诊断只写
stdout、多单元失败只保留第一个诊断、失败重建保留旧 todo.gb。测试夹具也从 GNU-only
`date +%s%N` 改为 Bun 的 `Date.now()`，并强制三个失败以 link order 的逆序完成。

仍有一个既存的可重入性边界：两个 `buildGbRom` 调用若同时使用同一输出目录，会共享
`gen-gb/gen_app.c`、三个 .rel 和 `app.ihx`。独立反例的 5 次运行中，3 次出现一个
Promise rejected，另 2 次两个 Promise 都 fulfilled 但 A 的 ROM 含 B 的程序。单次构建内部的
三路并行没有这个覆盖问题；本审核不把它扩成全局 job scheduler，建议后续单独修复输出隔离。

## Claim 矩阵

| 待核验项 | 对任务 440 原提交的判定 | 审核结果 / 限定 |
| --- | --- | --- |
| 端到端 median 3,108 → 1,847 ms（-40.6%） | Qualified | 独立串行 3,066 ms；修正前并行 1,844 ms（-39.9%）；修正后并行 1,828 ms（-40.4%）。收益量级复现，精确比例不应视为跨时段常量。 |
| 三个 .rel、crt0.rel、IHX、ROM 字节不变 | Pass | 5/5 次，每次 6/6 文件与父提交串行基线 `cmp` 相同；最终 ROM 32,768 B。 |
| 三个 sdcc compile 真正并发 | Pass | 真实 SDCC 三个 start 同为 1788824835127 ms，首个 end 为 1788824835490 ms，重叠窗口 363 ms。 |
| 等待所有子进程后再返回/链接 | Pass | 一个单元立即失败、另两个延迟 0.5/0.8 s 时，调用 1,107 ms 后返回，日志先记录最慢 end；成功路径 link 比最慢 compile end 晚 41 ms。 |
| 任一单元失败能传播 | Pass | 三个单失败用例分别通过；关闭失败分支 mutation 得到 2 pass / 4 fail。缺少 sdcc 时三个启动失败也被汇总。 |
| 失败前清除旧 .rel | Qualified → fixed | 原提交能删旧 .rel，但假定失败的 SDCC 不生成新文件。partial-output shim 使原提交得到 5 pass / 1 fail；审核修正会在汇总失败后再次删除失败单元的 .rel。 |
| 失败构建不留下可误认的最终产物 | Refuted → fixed | 原提交在成功构建后再失败，旧 todo.gb 仍存在且 SHA-256 不变；审核修正在构建开始时删除目标 ROM，并新增断言。 |
| 多失败顺序确定 | Pass，测试原来不充分 | `Promise.allSettled` 结果按输入顺序排列，原实现按 units/link order 收集。增强测试强制完成顺序 `gen_app → vapor_gb → vapor_core`，仍要求报告顺序 `vapor_core → vapor_gb → gen_app`。 |
| 多失败诊断不吞噬 | Refuted → fixed | 原提交只附首个失败的 stderr，其余只有文件名。审核修正按 link order 附上全部三个诊断，并支持 stderr → stdout → exit code 回退。 |
| PATH shim 不是假阳性 | Pass | 子进程启动前把 shim 目录放到 PATH；真实构建日志记录三条 compile 和一条 link。三条 compile 的时间重叠，且 link 仍委托绝对路径的真实 SDCC。 |
| 测试夹具可在 macOS/Linux 计时 | Qualified → fixed | 原 `date +%s%N` 依赖 GNU date；审核改用仓库已要求的 Bun `Date.now()`。夹具仍明确要求 `/bin/bash` 和 `[[ ... ]]`。 |
| 固定三路并发在低核主机仍有同等收益 | Refuted | `taskset -c 0` 下 n=5：串行 median 3,151 ms，并行 3,182 ms（+31 ms，+1.0%）。 |
| 同一输出目录可并发调用 | Refuted（既存边界） | 两个不同 app 同目录并发构建 5 次：3 次一侧 rejected；2 次两侧 fulfilled 但 `a.gb` 的哈希等于 B，不等于 A。 |
| 测试和行为 parity | Pass | 修正后 `bun test vapor/tests/` 为 77 pass / 0 fail / 7,433 expect；单独 parity 为 6 pass / 0 fail。 |

## 环境与基线

| 项 | 值 |
| --- | --- |
| 串行提交 | `59548d4bae5b4e34f12be34050f4509ef5cd125f`（任务 440 的父提交） |
| 被审核提交 | `5de4cd1cebabf4df14789ec82d82963bb31f63ab` |
| 系统 | Linux 6.8.0-64-generic x86_64 |
| CPU / RAM | 32 逻辑核 / 62 GiB |
| Bun | 1.3.14 |
| SDCC | 4.6.0 #16555，SM83 enabled |
| 输入 | `vapor/examples/todo/todo.tsx --target gb` |
| MGBA_PREFIX | `/tmp/mgba-prefix` |
| CC65_LIB | `/home/linuxbrew/.linuxbrew/Cellar/cc65/2.19/share/cc65/lib/none.lib` |

父提交在 detached worktree `/tmp/task447-review/serial` 运行；当前版本在 task 447 worktree
运行。两者共享同一 `node_modules` 和 PATH。每组先预热 3 次，再计时 15 次。计时从 CLI
进程启动前到退出后，包含 TypeScript 前端、生成 C、三单元编译、汇编、链接、makebin、rgbfix
和 debug JSON 写入。所有计时样本退出码均为 0。统计用线性插值分位数（n=15 时 Q1/Q3 是
排序后第 4/5 与第 11/12 个样本的均值）。

## 端到端计时

### 父提交串行

预热（ms，丢弃）：

```text
3074 3106 3085
```

原始样本（ms，运行顺序）：

```text
3067 3077 3066 3053 3118 3030 3044 3051 3037 3035 3047 3107 3092 3109 3103
```

排序后：

```text
3030 3035 3037 3044 3047 3051 3053 3066 3067 3077 3092 3103 3107 3109 3118
```

统计：median **3,066 ms**；Q1 **3,045.5 ms**；Q3 **3,097.5 ms**；IQR **52 ms**；
range **3,030–3,118 ms**。

### 审核修正后的并行版本

预热（ms，丢弃）：

```text
1882 1824 1842
```

原始样本（ms，运行顺序）：

```text
1844 1875 1875 1853 1825 1852 1828 1809 1825 1828 1840 1822 1811 1825 1822
```

排序后：

```text
1809 1811 1822 1822 1825 1825 1825 1828 1828 1840 1844 1852 1853 1875 1875
```

统计：median **1,828 ms**；Q1 **1,823.5 ms**；Q3 **1,848 ms**；IQR **24.5 ms**；
range **1,809–1,875 ms**。

相对串行 median：**-1,238 ms，-40.4%**。两组 range 不重叠；串行 min 3,030 ms 大于
并行 max 1,875 ms。

在审核修正前也独立取过一组 n=15：并行 median 1,844 ms、Q1 1,835.5 ms、Q3
1,858.5 ms、IQR 23 ms、range 1,821–1,870 ms，相对同一串行 median 是 -39.9%。这组与
修正后数据共同说明，任务 440 报告的 -40.6% 可复现到 0.7 个百分点内，但不应把单次百分比
当成固定值。

## 产物逐字节一致性

先在父提交串行构建一次，再在被审核并行提交连续构建 5 次。每次都对下列 6 个文件执行
`cmp -s`：

| 文件 | bytes | SHA-256（串行、5 次并行及审核修正后均相同） |
| --- | ---: | --- |
| `gen-gb/vapor_core.rel` | 10,810 | `271776e703d6bea4da9523a42a7bc6dae58326ff877d246e602f8296baec6dae` |
| `gen-gb/vapor_gb.rel` | 9,083 | `b7184fa5d21f5b9a7b7b3b77144340be0c15026380f32a031fa085cfc4d98f13` |
| `gen-gb/gen_app.rel` | 51,300 | `5efb05a68c6622967113f58f39a2e969b5cfff4e920084fb9c9a0e1383f46dca` |
| `gen-gb/crt0.rel` | 1,324 | `6f9699689e55968c7de87e3c892f299cd752c97a40d38f97dc857e8283da04c3` |
| `gen-gb/app.ihx` | 23,680 | `87e2b6f8fea21a808d616f0c2c291d24ebbaf1b705a3c31003b9df1f8cc47a39` |
| `todo.gb` | 32,768 | `8dc4d4132e164cbf895c68caccf466b811000fa7bca77f0e98645fbd89edf377` |

```text
run1: 6/6 byte-identical
run2: 6/6 byte-identical
run3: 6/6 byte-identical
run4: 6/6 byte-identical
run5: 6/6 byte-identical
after review fixes: 6/6 byte-identical
```

## 并发时间线与等待语义

PATH shim 委托 `/home/linuxbrew/.linuxbrew/bin/sdcc` 做真实编译，仅在调用前后记录毫秒时间。
一次成功构建的原始日志如下：

```text
S gen_app.c    1788824835127
S vapor_core.c 1788824835127
S vapor_gb.c   1788824835127
E vapor_core.c 1788824835490
E vapor_gb.c   1788824836115
E gen_app.c    1788824836795
S link         1788824836836
E link         1788824836879
```

三个 compile 都在首个 compile 结束前启动，实测重叠窗口 363 ms。link 在最慢 compile end
之后 41 ms 才启动。

早失败探针让 `gen_app.c` 立即返回 1，让另两个任务在结果产生后分别等待 0.5 s 和
0.8 s。结果：

```text
S gen_app.c    1788824439700
S vapor_core.c 1788824439700
S vapor_gb.c   1788824439700
E gen_app.c    1788824439724
E vapor_gb.c   1788824440227
E vapor_core.c 1788824440528
buildGbRom elapsed_ms=1107, ok=false
```

函数在最慢进程记录 end 后才返回；没有未等待子进程。实现使用 `Promise.allSettled`，
返回数组保持输入顺序，随后按 `units`/link order 收集错误。

## 失败、陈旧输出和不同 SDCC 行为

### 任一单元失败

三个单元逐个注入失败均得到 `ok=false`，消息包含对应 .rel、`target gb` 和工具
诊断，失败单元的 .rel 与目标 ROM 均不存在。链接、makebin 和 rgbfix 不运行。

PATH 中完全没有 sdcc 时，三个启动均失败并得到：

```text
sdcc failed compiling vapor_core.rel for target gb (vapor_gb.rel, gen_app.rel also failed)
vapor_core.rel: bun: command not found: sdcc
...
```

### 部分输出

原测试 shim 在失败分支不创建 `-o`，因此只能证明“构建前删除旧文件”。一个编译器或
wrapper 可以先创建/截断输出再返回非零。注入 33 字节部分 .rel 后，原提交正确停止链接，
但 `gen_app.rel=exists bytes=33`，原测试得到 5 pass / 1 fail。

审核修正做两阶段清理：派发前清除三份旧 .rel；收集失败后再清除所有失败单元的输出。修正后
同一探针得到：

```text
ok=false
gen_app.rel=missing
todo.gb=missing
```

### 旧最终 ROM

原提交先成功构建再让 `gen_app.c` 失败时，旧 ROM 不会被链接，但仍留在磁盘：

```text
before: exists=yes bytes=32768 sha256=8dc4d413...edf377
rebuild: ok=false
after:  exists=yes bytes=32768 sha256=8dc4d413...edf377
failed rel exists=no
```

原测试在全新目录断言 ROM 不存在，未覆盖 rebuild。审核修正在构建开始时 `rm(outRom,
{ force: true })`，并在 rebuild 用例断言失败后旧 ROM 不存在。

### 诊断流与多失败

原提交只读 stderr，并在多个失败时只附第一个单元的诊断。审核后的回退次序是 stderr、stdout、
退出码；多失败时每个 `rel: detail` 都按 link order 输出。增强用例让三个失败逆序完成：

```text
completion: gen_app.c → vapor_gb.c → vapor_core.c
report:     vapor_core.rel → vapor_gb.rel → gen_app.rel
```

这同时排除了“测试没有真的制造乱序”和“诊断按完成顺序漂移”两类假阳性。

## Mutation 结果

每次 mutation 只改变一个条件，运行 `bun test vapor/tests/gb-build.test.ts` 或目标用例后还原：

| mutation | 结果 | 被抓住的性质 |
| --- | --- | --- |
| `Promise.allSettled` 改成逐个 `await` | 4 pass / 2 fail | overlap 失败；逆序完成前置断言也失败。 |
| 删除构建前三份 .rel 清理 | 5 pass / 1 fail | rebuild 后旧 `gen_app.rel` 仍存在。 |
| `if (failures.length > 0)` 变为 false | 2 pass / 4 fail | 三个单失败与多失败报告用例失败。 |
| 收集后反转 failures | 0 pass / 1 fail（其余 filtered） | 固定 link-order 首错误断言失败。 |
| 删除审核新增的失败后 partial .rel 清理 | 5 pass / 1 fail | shim 留下的部分 `gen_app.rel` 被检测。 |
| 删除审核新增的旧 ROM 清理 | 0 pass / 1 fail（其余 filtered） | rebuild 后 `todo.gb` 仍存在。 |
| 删除 stdout 诊断回退 | 5 pass / 1 fail | stdout-only 的 `gen_app.c` 诊断丢失。 |

还原所有 mutation 后，GB build 测试为 6 pass / 0 fail / 35 expect。

## PATH shim 与可移植性

`gb-build.test.ts` 在父测试进程的原始 PATH 上先解析 `REAL_SDCC`，再为每个用例创建
唯一 `bin/sdcc`，并把该目录放到新 Bun 子进程的 PATH 首位。时间线中同时出现三条带
C basename 的 compile 和无 basename 的 link，证明 compile 确实经过 shim；link 由 shim 用
绝对 `VP_SDCC_REAL` 委托，不会递归命中自己。

原 `date +%s%N` 在 GNU coreutils 可用，但 macOS BSD date 不支持 `%N`。审核改用
`bun -e 'process.stdout.write(String(Date.now()))'`；Bun 已是测试运行器，不增加工具依赖。
shim 仍使用 `#!/bin/bash` 和 `[[ ... ]]`，因此不是 POSIX `sh` 脚本，但当前
Linux/macOS 开发环境都有 Bash。

## 低核与外层并发风险

用 `taskset -c 0` 把两种构建限制到一个逻辑核，预热 2 次、测量 5 次：

| | 原始样本（ms） | median | IQR | range |
| --- | --- | ---: | ---: | ---: |
| 串行 | 3157 3141 3123 3151 3416 | 3,151 | 16 | 3,123–3,416 |
| 并行 | 3263 3167 3136 3186 3182 | 3,182 | 19 | 3,136–3,263 |

并行 median 增加 31 ms（+1.0%）；最后一个串行样本是高值，因此小样本 range 不用于判断。
这说明三路并发的收益依赖可用 CPU。当前实现每个 GB 构建固定最多三个 compile 子进程，资源
上界清楚；如果 CI 在外层同时启动 N 个 GB 构建，compile 进程数可达到 3N。本任务不引入
全局 job scheduler。

## 同输出目录并发反例

构造 A/B 两个 app，唯一差异是种子文本 `SHIP POCKET VAPOR` 与 `SHIP RACE VAPOR`。
先分别构建得到期望哈希：

```text
A 8dc4d4132e164cbf895c68caccf466b811000fa7bca77f0e98645fbd89edf377
B e41eaf980bee2987dec5a24b7608ea6696ae8dc3152d22079d4676fe6034ada9
```

再用 `Promise.allSettled([buildGbRom(A, dir/a.gb), buildGbRom(B, dir/b.gb)])`，连续 5 次：

```text
run1 fulfilled,fulfilled  a=B(WRONG) b=B(correct)
run2 rejected,fulfilled   a=missing  b=B(correct)
run3 rejected,fulfilled   a=missing  b=A(WRONG)
run4 fulfilled,fulfilled  a=B(WRONG) b=B(correct)
run5 rejected,fulfilled   a=missing  b=B(correct)
```

原因是 `genDir = join(dirname(outRom), "gen-gb")`；不同输出文件只要 dirname 相同，就会
共享并覆盖所有中间文件。这个问题在父提交的串行单次实现里也存在于“两个 build 调用彼此并发”
的场景，不是任务 440 把一个 build 内的三个独立 TU 并行后才产生。后续修复应给每个构建隔离
中间目录或对同一 genDir 加互斥，并新增不同 app 的同目录并发测试。

## 全量验证

最终代码执行：

```bash
export MGBA_PREFIX=/tmp/mgba-prefix
export CC65_LIB=/home/linuxbrew/.linuxbrew/Cellar/cc65/2.19/share/cc65/lib/none.lib
bun test vapor/tests/
```

结果：**77 pass，0 fail，7,433 expect() calls，8 files**。其中单独
`bun test vapor/tests/parity.test.ts` 为 **6 pass / 0 fail / 7,171 expect() calls**：GBA、GB、
NES 各自的逐步渲染和 runtime tripwire 均通过，oracle 是三者共同的比较基准。

任务上下文预告本机 NES 会因 ld65/none.lib 不匹配失败；本 worktree 的 `ld65 --version`
仍报告 V2.18，但按任务 447 的 Verification 明确设置上述 Linux cc65 2.19 `CC65_LIB` 后，
NES parity 实际可运行并通过。没有修改或修复系统工具链。

## 审核修正

- `vapor/compiler/rom.ts`：构建开始清除旧目标 ROM；失败后清除失败单元可能留下的部分
  .rel；读取 stdout-only 诊断；多失败保留全部诊断且维持 link order。
- `vapor/tests/gb-build.test.ts`：rebuild 同时覆盖旧 ROM 与 partial .rel；单失败覆盖 stdout；
  多失败强制逆序完成并断言全部诊断。
- `vapor/tests/harness/sdcc_shim.sh`：用 Bun 生成可移植毫秒时间戳；支持每单元延迟、
  partial output 和 stdout-only 失败。

成功路径产物在修正后仍与父提交的六个文件逐字节相同；修正后 n=15 的并行 median 1,828 ms。
