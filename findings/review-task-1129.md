# Review task 1129 — M1 relay+map 运行时分支（relay L1/L2 + tile-viewport/resource-pack 合并）

- Reviewer: task-1152（跨族独立复核；未使用被审任务的自述作为依据）
- 被审分支：`fleet/task-1129`，tip `affcf493`（`verify:` 报告提交），实现合并提交 `9db60c0e`
- 父：`1b31d3ff`（relay-l1-l2 = upstream/main@780218d + 62 relay 提交）、`e2226e8f`（upstream/feat/local-resource-packs，自 fork `10aee589` 起 25 提交）
- 复核机：`/home/tangollvm/.fleet/worktrees/task-1129`（所有产品级命令在该 worktree 跑），临时合并/用例放 `/tmp`，日志放本 worktree `.pocket-build/validation/task-1152/`（gitignored）
- 协议依据：`/var/tmp/oss/relay-survey/findings/relay-protocol-draft.md` R5 §3.3–3.9

## 结论总览

| # | claim / 检查项 | 裁决 |
|---|---|---|
| 1 | 合并为双父 `--no-ff`，两系历史均保留 | 成立 |
| 2 | 24 个冲突、文件集合 | 成立（独立重放，24/24 同集） |
| 3 | relay 协议代码字节未改 | 成立（10 个 blob 逐一相同） |
| 4 | feature 关键文件字节未改 | 成立（9 个 blob 逐一相同） |
| 5 | exports/subpaths 双模块接线 | 成立 |
| 6 | `bun tools/test.ts` 14/14（合并树） | 成立（独立复跑 135.9s） |
| 7 | 基线 1b31d3ff 14/14（收益对照） | 成立（独立复跑 133.2s） |
| 8 | `bun tests/contract.ts` | 成立（all green） |
| 9 | tape 180 帧对锚点 5b4a346 | 成立（仓内 hashes 与 5b4a346 锚点双绿） |
| 10 | generators 无 drift | 成立（gen 后 git status 空） |
| 11 | TS 帧层向量 | 成立（48 向量，19 pass 含 C 入口） |
| 12 | C 帧层 `-std=c11 -Wall -Wextra -Werror` | 成立（零告警；直编 relay_frame.c 亦零告警） |
| 13 | Rust std / no_std / wasm32 | 成立（27+8+10+1，4 ignored；wasm32 双配置 Finished） |
| 14 | 常量与草案 §3.3 逐字段一致 | 成立（20 项脚本比对全 OK） |
| 15 | engine/core 150 / workspace check / desktop check / 3DS core release check | 成立（150；3 个 check Finished exit 0） |
| 16 | 25 / 47 提交计数、7 个 provider 触碰等"为何 merge"数字 | 成立（25、47 复核一致；其余为叙述性依据不逐条判） |
| 17 | 5 个自动合并错误的修复（platforms 重复、ffi 重复注册、resource-cache 守卫、shared queue、teardown 初始化） | 成立（逐条 grep/代码核实） |
| 18 | 测试有牙：移植的准入/read-gate 有变异红 | 成立（provider 变异 2 红；gate 两 chunk 反例变异红；C 层 8 内置变异） |
| 19 | 交付纯净：实现提交无 findings/repro，前缀合规，报告单独 `verify:` | 成立 |
| 20 | "relay TS 11 files" | **推翻（计数笔误）**：实为 10 个 tests/relay-*.test.ts |
| 21 | 合并交集守卫（resource-cache revalidated × releaseResponse）有测试 | **部分推翻**：3 处守卫代码正确但 0 测试覆盖（变异现套全绿），非阻断 |
| 22 | PSP/3DS 原生交叉编译未在本机验证 | 无法判定（同被审：本机无 PSP SDK/devkitARM）；已由可行替代检查覆盖，记为残余风险 |

## 1. 合并结构与冲突复现

**裁决：成立。**

```
$ git log --pretty='%h %p %s' -1 9db60c0e
9db60c0e 1b31d3ff e2226e8f merge: local resource packs onto the relay runtime
```

在临时 worktree `/tmp/t1152-merge-repro`（`git worktree add --detach … 1b31d3ff`）执行
`git merge --no-ff --no-commit e2226e8f`：exit 1，`git diff --name-only --diff-filter=U | wc -l` = **24**。
将冲突集合与被审报告表格 24 行排序后 `diff`：输出 `CONFLICT SETS IDENTICAL (24/24)`。

合并后检查：合并树无残留冲突标记（`git grep -nE '^(<<<<<<<|=======|>>>>>>>) ' 9db60c0e` 无命中）。

### relay 侧零改动（协议符合性的结构性保证）

| 路径 | 1b31d3ff blob | 9db60c0e blob |
| --- | --- | --- |
| framework/src/relay/{frame,session,credit,resource,endpoint,tape}.ts（6） | — | 全部 SAME |
| contracts/spec/relay.ts | 0b0cda81 | SAME |
| tools/relay-wire.ts | ce7abf66 | SAME |
| docs/RELAY.md | f0d0cf8e | SAME |
| tests/fixtures/relay（tree） | 874e2bde | SAME |

协议草案 §3 的实现因此在合并树中与已评审的 relay tip 逐字节一致；不存在"合并顺手改协议"的路径。

### feature 侧零改动（抽查的 9 个独有文件）

`framework/src/tile-viewport.ts`、`resource-pack.ts`、`drag-filter.ts`、`tools/resource-pack.ts`、
`hosts/3ds/src/asset_pack.{c,h}`、`hosts/3ds/src/offload_image.h`、`hosts/psp/src/{mesh,analog}.rs`
相对 `e2226e8f` 全部 SAME。`hosts/psp/src/offload_packet.rs` 亦 SAME；
`hosts/psp/src/offload.rs` 与 feature 仅差一行恢复的注释（"Only boot initialization allocates…"），与报告 row 16 一致。

### 接线

`package.json` exports：173 `./resource-pack`、175 `./tile-viewport`（另含 vue-vapor/octane 别名各 2 行）；
`framework/compiler/subpaths.ts` 74/76 同名条目。contracts drift guard 随套件验证 exports 与 subpaths 一致。

## 2. 关键冲突解决的人工复核

### 2.1 resource-cache.ts（row 7）— 成立，逻辑正确

`git diff 1b31d3ff 9db60c0e -- framework/src/resource-cache.ts` 显示相对 relay 树的全部语义变化：

1. 新增可选 `releaseResponse?(raw)`（feature 带来的外部 staging 释放钩子）；
2. 在 stop/迟到投递/超预算/completion materialize 的 `finally`/同步 throw 五处接入释放；
3. 所有接入点都带 `"value" in result` 联合收窄，relay 的 `{ok:true,revalidated:true}` 成员不会被当作带字节结果释放；
4. `step()` 中 `available()` 门移到 speculative cancel **之前**（"Do not discard useful in-flight prefetch…"）。

第 4 点报告未在 row 7 明说，但核实它**逐字来自 feature 分支**（`git show e2226e8f:framework/src/resource-cache.ts` 第 242–244 行原文一致），属自动合并结果，不是被审手写入的未报告行为；该分支有 `tests/resource-cache.test.ts` "transport saturation preserves desired prefetch work…" 覆盖。

relay 的 revalidated 分支（completion 中 "revalidated result with no resident value" 抛错、不 materialize、不 dispose resident value，resource-cache.ts:162–170）完整保留。

### 2.2 tools/offload-provider.ts（row 22）— 成立

- 八字节信用不变量 `pending.size + replies.length + Number(writing) < OFFLOAD.pending`（offload-provider.ts:33），与草案 §3.9 "queued+new≤cap、结果未 materialize 仍占额度、正在写出的 frame 计入 queued bytes" 同形；`OFFLOAD.pending=8`（contracts/spec/offload.ts:7）。
- 旧 executor 隔离：`replyToDevice` 首行 `if (worker !== owner || stopped) return`；disconnected 先清 pending/replies 再 `worker=undefined` 并 `return old?.terminate()`，把重连定时器推迟到 teardown settle——与报告叙述一致。
- process 子进程 SIGKILL reaping、5s connectTimeout、9s request deadline（不重发 mutation）、method 白名单正则 `^[a-z][a-z0-9_.-]{0,63}$`（与草案 §3.4 op 拼写同构）均在。

### 2.3 companion-session.ts 扩展 — 成立，但既有测试不直接覆盖 read-gate（见 §4 反例）

新增 `write(frame)`、`admit()` 门、`resume()`、`drained`、`disconnect(reason)`、`connectTimeoutMs`。
读门实现（companion-session.ts:80–90、104–112）：无 admit 时直通；有 admit 时每 chunk `socket.pause()`，
一次只持一个 chunk（held 期间再来 chunk 直接判 "input credit exceeded" 断链），
OffloadDecoder.push 在记录边界按 admit 返回值中断并保留 consumed 偏移，resume 后从后缀继续。

### 2.4 其余 21 个冲突 + 5 个自动合并修复 — 逐条抽查成立

- `contracts/spec/platforms.ts` PSP 块（251–300 行区间）`io.offload` 恰好 1 次；
- `hosts/psp/src/ffi.rs`：`js_offload_session/submit/take` 各 1 定义，单个 `io` 对象、单次 `globalThis.offload` 注册；uploadMesh/uploadImage/releaseMesh/releaseImage 与 `ui().set_mesh_commands(true)` 折入同一注册块（ffi.rs:1304–1320）；
- `hosts/shared/offload_queue.h`：`image_token` 字段与 `offload_push_ticket(...)` 在共享头内，旧 `offload_push` 变为 token=0 的包装；
- `tools/companion-session.ts:119` `let teardown: void | Promise<unknown> = undefined;`；
- `hosts/psp/build.rs:33` 保留 main 的 16 hex 严格校验；merge 树该文件与 1b31d3ff 零 diff；
- `hosts/psp/src/main.rs`：elapsed 输入（665–667）、`offload_local::frame()`（669）、7 参 JS_Call（672）、teardown 三连 `offload_local::reset(); mesh::reset(); ge::retire_textures();`（803–805）；
- `hosts/3ds/Makefile:113` OBJECTS 同时含 media.o 与 asset_pack.o；main.c start/stop 各自 #ifdef（734/737、1070/1073）；qjs.c shutdown 三连（1004/1006/1008）；
- `.github/workflows/3ds-runtime.yml`：main 的 `bun test` 步骤（:20）与 feature 的 `--conditions=browser` 步骤（:21）并存；paths 为两列表 union；
- `tools/offload-usb-provider.ts` 与 feature blob 完全相同；
- `contracts/spec/offload.ts` 含 feature 的 uploadImage/uploadMesh/release*（:26–30）、OFFLOAD_IMAGE/OFFLOAD_MESH（:64/:89）且保留 main 的 uploadCoverage（:37）。

## 3. 门禁（数字全部本机重跑）

环境：`PATH=$HOME/.cargo/bin:$PATH MGBA_PREFIX=/tmp/mgba-prefix`，cargo 1.98.1，bun 1.3.14。

| 检查 | 命令 | 被审报告数字 | 本 review 数字 | 裁决 |
| --- | --- | --- | --- | --- |
| 合并树全量 | `bun tools/test.ts` | 14/14，774.5s | **14/14，135.9s，exit 0**（11 处 "0 fail"） | 成立；耗时差异来自被审跑时 PSP build-std 占 cargo package-cache 锁（其 handheld 613.3s），本次无并发，handheld 6.1s |
| 基线 | 同上 @1b31d3ff（独立临时 worktree） | 14/14，135.6s | **14/14，133.2s，exit 0** | 成立：合并无回归 |
| 契约 | `bun tests/contract.ts` | all green | `contract: all green` | 成立 |
| 生成器 | `bun run gen` + git status | 无 drift | 重写后无 diff，git status 空 | 成立 |
| tape | `tape replay hero-main … --assert` | 180 帧 OK | 仓内 hashes 与 `/var/tmp/oss/baselines/hero-main.hashes.5b4a346.json` **双双** "tape: OK — 180 frames" | 成立 |
| tsc | `tsc --noEmit` | exit 0 | exit 0，无输出 | 成立 |
| TS+C 帧向量 | `bun test relay-frame relay-frame-c` | unit stage 绿 | **19 pass / 0 fail / 5858 expect()** | 成立 |
| Rust std | `cargo test -p pocket-relay` | 27+8+10+1，4 ignored | 27+8+10+1，4 ignored | 成立（精确复现） |
| Rust no_std | 同上 `--no-default-features` | 同数 | 同数 | 成立 |
| Rust wasm32 | 目标能编 | 能编 | std/no_std 各 `Finished`（wasm32-unknown-unknown） | 成立 |
| C 告警 | c11 Wall Wextra Werror | 零告警 | 测试 harness 两趟 ASan/UBSan 编译通过；另直接 `cc -std=c11 -Wall -Wextra -Werror -Ihosts/shared -c relay_frame.c` 零告警 | 成立 |
| engine/core | `cargo test` | 150 | **150 passed; 0 failed** | 成立 |
| workspace | `cargo check --workspace` | Finished | Finished exit 0 | 成立 |
| desktop | `cargo check`（hosts/desktop） | 14.81s | Finished exit 0 | 成立 |
| 3DS core | `cargo +nightly-2026-07-02 check --release` | Finished 1m36s | **Finished exit 0**（目标缓存热，0.88s；toolchain `nightly-2026-07-02` 与 armv6k target 本机齐备） | 成立 |
| 移植面定向 TS | 14 文件 137 pass/1 误报后 4/4 | — | 本次直接跑 10 个相关文件：**93 pass / 0 fail / 1098 expect**；offload-provider 单文件 **6 pass** | 口径不同但全绿 |

### 草案 §3.3 逐字段

用 `tests/fixtures/relay/constants.json` 对草案帧头表脚本比对（magic PRLY、major1/minor0、48B 头/44B 体、
frameBytes@0u32、magic@4、major@8…reserved@44u32）：**20/20 OK**。
48 个 fixture 向量（48 .bin/48 .json）被 TS、C、Rust 三端测试共同消费；Rust `links_every_vector_in_the_index`
断言向量数=48 并全覆盖，单跑通过。

## 4. 反例与变异（测试有牙）

1. **provider 准入（合并移植的核心新代码）**：备份后把
   `pending.size + replies.length + Number(writing) < OFFLOAD.pending` 改为漏计 queued replies。
   `tests/offload-provider.test.ts` 立刻 **2 红**：
   "slow writes preserve bounded duplex admission instead of stopping healthy work"（196ms）与
   "a slow device drains a burst of images without backlog disconnects or lost requests"（64 图 burst，10s 超时）。
   恢复后 6/6 绿，git status 干净。→ 测试对该变异有牙。
2. **read-gate 反例（自建最小用例，留 `/tmp/t1152-gate-check.test.ts`，不入交付）**：
   server 在一个 TCP 段写 2 条记录、100ms 后（admit 仍关闭）再写 14 条。原版：不断链、先收 1 条，
   reopen+resume 后 16 条全到（6 断言全过）。把 companion-session.ts:86 变异为无条件 `socket.resume()`：
   第二段触发 `if (held) destroy()`，用例 305ms 变红（`disconnected === true`）。→ gate 行为正确且可被变异区分；
   但注意该反例是**本 review 新构造的**，仓内既有用例不直接覆盖门（被审测试通过 provider 端到端间接走到）。
3. **C 帧层**：`tests/relay-frame-c.test.ts` 内置 8 个 check-removal 变异
   （magic/reserved/seq/correlation/wire-limit/UTF-8/UTF-8 跨度/CANCEL stream），每个变异要求对应向量错误码消失，
   随 unit stage 全绿——先证伪"变异失效"。
4. **找过但未构出失败的路径**：(a) 单 chunk 内多条记录的过投递——解码器在记录边界回调 admit，
   单 chunk 场景原版与变异行为相同，必须用第二 chunk 才能区分（已采此反例）；
   (b) revalidated 与 releaseResponse 的 completion 路径——交集代码正确（见 §5），未找到语义反例。

## 5. 发现的问题

### 5.1 [非阻断] resource-cache 合并交集的 3 处守卫零测试覆盖

被审任务在 `framework/src/resource-cache.ts` 手写了联合收窄：

- `:87` `stop()`：`if (result?.ok && "value" in result) releaseResponse(result.value)`
- `:114` 迟到/换代投递：同样收窄后才释放
- `:119` `start()` 同步 throw 路径：同样收窄

事实：合并树 `tests/resource-cache.test.ts` 共 20 个用例，全部来自两个父分支
（feature 17 + relay 19，去重并集=20；对两个父树做 test() 标题集合差分为空），
全文件 0 处出现 `releaseResponse`。把 :87 的守卫变异为 `if (result?.ok)`：

- 现有 20 个用例**仍然全绿**（变异存活）；
- 自建最小用例（revalidated 结果已进入 entry.result、尚未 completion 时 `reconcile([])`）下，
  调试输出 `releases [ undefined ]`——释放回调被以 `undefined` 调用；用严格断言
  `expect(0 in releases).toBe(false)` 后变异变红、原版变绿。

裁决：**守卫代码本身正确**（两个自建交集用例——正常 revalidate 不释放 confirmation、
换代后迟到 revalidated 不释放——在原版均通过：`2 pass / 5 expect`），但缺少防回归测试。
建议 M2 前在 `tests/resource-cache.test.ts` 补 1–2 个 releaseResponse×revalidated 交集用例
（脚本与反例已留在 `/tmp/t1152-intersection.test.ts`、`/tmp/t1152-stopcase.test.ts`）。

### 5.2 [非阻断] 报告计数笔误

报告称 relay TS 测试 "11 files"；`tools/test.ts` unit stage 实际登记 **10** 个
`tests/relay-*.test.ts`（relay-credit/docs/endpoint/frame/frame-c/resource/session/sim-tape/tape/wire），
全部随 14/14 套件跑绿。不影响结论。

### 5.3 [残余风险，与被审声明一致] PSP/3DS 原生侧未交叉编译

本机无 PSP SDK（libquickjs-sys C 构建缺 patch.h）与 devkitARM，`hosts/psp` 的 build-std 检查和
3DS C 固件编译无法执行；被审报告"Not verified"表如实声明。已做的替代验证：
3DS core 的 armv6k Rust 包装层 release check 通过（含 `ui_upload_mesh`、`ui_register_external_texture` 绑定）；
`hosts/3ds/src/offload.c` 被 offload-images 测试以 clang ASan+UBSan 编译并端到端跑 image/mesh ticket；
ffi/main/offload.rs 等冲突块逐行读回。PSP Rust 侧仅有读码 + 间接证据，建议有 PSP SDK 的环境补一次
`cargo +nightly check -Zbuild-std -Zjson-target-spec --target targets/mipsel-sony-psp.json`。

## 6. 交付纯净度

- `git diff --name-status 5b4a346 9db60c0e | grep -iE 'findings|repro|\.log$|\.tmp$'`：无命中；
  实现提交（merge `9db60c0e`）不含报告/抓包/日志。
- 报告仅在最后一个独立提交 `affcf493 verify: …`，只加 `findings/M1-runtime-branch.md`（+136 行）。
- 两个被审产出提交前缀合规：`merge:` 合并、`verify:` 报告；并入的 25 个上游提交保持原 hash（merge 非 rebase）。
- `relay+map-runtime` 分支与 `/tmp/relay-map` worktree 未被改动（仍指 1b31d3ff）。
- 98 文件 +5391/−340（merge vs 1b31d3ff）与报告一致；含报告提交为 99 文件 +5527/−340。
- 25/47 提交计数独立复现：`git rev-list --count 10aee589..e2226e8f`=25，`10aee589..780218d`=47。

## 7. 产物与日志

- 本报告：`findings/review-task-1129.md`（review 分支 `fleet/task-1152`）
- 复跑日志（gitignored）：`.pocket-build/validation/task-1152/suite.log`（合并树 14/14）、
  `…/base-suite.log`（基线 14/14）
- 反例脚本（/tmp，不入库）：`t1152-gate-check.test.ts`、`t1152-intersection.test.ts`、`t1152-stopcase.test.ts`

## 最终裁决

无阻断项。两个非阻断改进：(1) 给 resource-cache 的 releaseResponse×revalidated 合并守卫补回归测试；
(2) 修正报告 "11 files" → 10。PSP/3DS 原生交叉编译为环境性残余风险，已如实声明且有替代验证。

PASS
