**Task 1204 对 task 1189 的独立跨族复核：FAIL。** 两个现有 JavaScript 生命周期缺陷阻断 M2 收口：连续两次替换 source 后旧 stream 占满 attachment 字节窗口；attachment generation 从一个正数变成另一个正数时，已 READY 的 guest 不与新 peer 重建会话。原有 map、runtime、时序及变异门禁均通过，不能覆盖这两个反例。

Reviewer 为本 task 的 traecli / GPT family，Builder task 1189 为 claude family；未另派 agent。本报告依据独立检出的运行结果和源码，不以 Builder 自报或 task 1198 的模拟器截图代替验收。报告日期：2026-09-20。

**审查身份、环境及证据索引。**

| 对象 | 精确身份 |
| --- | --- |
| Pocket Map | `306b4a8b3f6622a2b70d5adc6da83175591a4193`，交付分支 fleet/task-1189 |
| PocketJS runtime / map gitlink / Reviewer 起点 | `951b61988c078b29ab6cb7bcba932b128f5331cc`，Builder 分支 fleet/93f58b98a624/task-1189 |
| Reviewer 分支 | fleet/93f58b98a624/task-1204 |
| 工具 | Bun 1.3.14；cargo 1.98.1；rustc 1.98.1；GCC 13.3.0；wasm32-unknown-unknown 已安装 |
| 独立检出 | [map](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map)；[runtime](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/runtime) |
| 本轮产物根 V | /home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z |
| 产物索引 | [artifact-manifest.json](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/artifact-manifest.json)，149 个已登记脚本、原始日志、收据与 mutation patch 的路径、SHA-256、大小和 ledger ID |
| 身份与干净树证据 | [setup/provenance-final.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/setup/provenance-final.log) |

下文的 `V` 代表上述产物根，`M` 代表 \V/map\，`R` 代表 \M/runtime\。命令的 cwd、argv、环境覆盖、起止时间、exit 和日志 hash 在各同名 JSON 收据内。共享 Git objects 的克隆固定在上述两个 commit；在 runtime 执行 bun install --frozen-lockfile，再在 map 安装依赖并执行 bun scripts/setup.ts。检查结束时，独立 map/runtime 与原始 Builder 的两个工作树 git status --porcelain=v1 输出均为空。变异只发生在 V/mutation 内的 git-archive 副本，七次均恢复原字节。

查阅的原始材料包括 [task 1151 findings](/home/tangollvm/.fleet/worktrees/task-1151/findings/review-task-1130.md)、[Builder M2-review-fixes.md](/home/tangollvm/.fleet/worktrees/task-1189-map/findings/M2-review-fixes.md)、其 mutation/summary.json，以及 runtime m1-gates.log。Builder 报告第 12 行将自身 commit 写作 f1102c7；git log 与实际检出均确认最终 map tip 为 306b4a8b3f6622a2b70d5adc6da83175591a4193，本报告使用后者。[task 1198 M3-sim.md](/home/tangollvm/.fleet/worktrees/task-1198/findings/M3-sim.md:3) 使用另一条 map 交付线及 runtime f1ddc777，12-capture 对拍只作旁证。

**R1：第二次 source replacement 保留旧 namespace stream，字节窗口耗尽后画面无法就绪。优先级 P1，阻断。**

最小条件：同一 relay session 内，启动 raster source A，变更 tileURL 得到 B，待 B 的画面就绪后再次变更 tileURL 得到 C。两次 refresh 都能将新 catalog/source 送到 guest，第二次的瓦片请求却无法取得 stream 配额。

复现脚本 [review-boundaries.test.ts](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/review-boundaries.test.ts:7) 使用未修改的 createRig、MapRelayAuthority、model 和 client。第一次使用 RASTER_URL_ALT，第二次使用 https://third.example.test/{z}/{x}/{y}.png；它们是 fixture URL，不访问外网。

```sh
cd "/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z"
bun test --conditions=browser ./review-boundaries.test.ts
```

在 [boundaries-control-final.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/reviewer/boundaries-control-final.log) 和独立重复的 [boundaries-confirmation.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/reviewer/boundaries-confirmation.log) 中，命令均 exit 1：1 pass / 2 fail / 5 expectations。两个失败分别为本项和 R2 的握手中反例；通过项为本项的 stream retirement 对照。两轮计数相同。

| 观察点 | A 启动 | A → B | B → C |
| --- | ---: | ---: | ---: |
| source | 305f2b6a251eefcd | 7dd3bdef20131e3c | 627588d74816c446 |
| ready screen | true | true | false |
| GET / objects 累计 | 9 / 9 | 17 / 17 | 17 / 17 |
| OPEN / subscribe 尝试累计 | 2 / 2 | 3 / 3 | 307 / 8 |
| 活跃 subscriptions | 2 | 3 | 3 |
| protocolErrors / BUSY bind refusals | 0 / 0 | 0 / 0 | 5 / 5 |
| 可见瓦片 | 4 ready | 4 ready | 4 pending，900 帧门限超时，追加 10 帧后仍 pending |

A → B 后仍有 stream 0 = 32,768 B、catalog stream 1 = 8,192 B、A stream 2 = 208,896 B、B stream 3 = 208,896 B，共 **458,752 B，已用完 attachment 字节预算**。B → C 后 authority 只列出 map/627588d74816c446，guest 也已安装该 source；旧 A/B streams 仍保留，C 没有字节窗口。

原因可沿代码核对：[app/relay.ts](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/relay.ts:74) 保存 namespace → stream/subscription，[streamFor](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/relay.ts:126) 创建 OPEN 和 subscription；[onEnd](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/relay.ts:144) 只在订阅结束时删除映射。[applyCatalog / installInfo](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/model.ts:155) 在 source 改变时清空 collections，却没有回收已从 catalog 删除的 namespace stream。runtime 的 [relayStreamSlice](/home/tangollvm/.fleet/worktrees/task-1204/framework/src/relay/endpoint.ts:210) 从 attachment 中扣除全部既有分配，[onStreamOpened](/home/tangollvm/.fleet/worktrees/task-1204/framework/src/relay/endpoint.ts:698) 在剩余字节为 0 时产生 STREAM_LIMIT。

诊断对照在 B 就绪后调用现有 [resetStream](/home/tangollvm/.fleet/worktrees/task-1204/framework/src/relay/endpoint.ts:495) API 释放 A 的 stream 2；[applyStreamReset](/home/tangollvm/.fleet/worktrees/task-1204/framework/src/relay/endpoint.ts:806) 会释放 allocation 和 subscription。相同的 C replacement 随后 **10 帧就绪，25 GET / 25 objects，0 protocolErrors**。这定位到旧 namespace 的生命周期管理，不要求扩大窗口，也不依赖 native lane。

修复验收应覆盖 catalog 删除/替换后的旧 stream、subscription、窗口释放，以及连续多次 replacement 后仍能读到新 source；当前回归只覆盖一次 source replacement。

**R2：positive → positive attachment generation 不触发重连，新 peer 留在 IDLE。优先级 P1，阻断。**

[RelayChannelOps.session 合同](/home/tangollvm/.fleet/worktrees/task-1204/contracts/spec/relay-channel.ts:37) 要求 generation 在 attachment 重建时改变，guest 在变化时丢弃 session 状态；合同没有要求 guest 必须在两次 frame 采样之间观测到 0。[channel.step](/home/tangollvm/.fleet/worktrees/task-1204/framework/src/relay/channel.ts:83) 在记录投递前报告任意 generation 变化。但是 [mapTransport](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/transport.ts:34) 对所有正数只调用 relay.connect()，而 [connect()](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/relay.ts:226) 只在 IDLE 发 HELLO。HELLO_SENT 或 READY 遇到正数换代均不丢弃旧 session。

较强复现 [review-generation.test.ts](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/review-generation.test.ts:8) 先让两端 READY，再用新的 provider endpoint 替换旧 peer，并令 host generation 从 1 变 2。泵送 30 帧后比较两端状态；同一测试的 0 → 3 路径为通过的对照。

```sh
cd "/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z"
bun test --conditions=browser ./review-generation.test.ts
```

[ready-generation.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/reviewer/ready-generation.log)：exit 1，0 pass / 1 fail / 4 expectations，只有正数换代后的期望断言失败。

| 阶段 | guest phase | provider phase | guest sessions | HELLO 数 | guest connected() |
| --- | --- | --- | ---: | ---: | --- |
| attachment 1 已建立 | ready | ready | 1 | 1 | true |
| 换成新 peer，generation 1 → 2，30 帧后 | ready | idle | 1 | 1 | true |
| generation 经 0 → 3 的对照，30 帧后 | ready | ready | 2 | 2 | true |

R1 的脚本还给出 1 → 2 发生在 HELLO_SENT 的最小反例：HELLO 保持 1 条，经过 0 后才变为 2 条。修复应在正数 generation 改变时先丢弃旧 session，再与新 peer 握手，并保证此动作发生在该代记录投递之前。需要同时覆盖 READY、握手中以及未观测到 detached 帧的情况。

**Task 1151 B1–B6 及 Builder 相关声明的复核。**

| 原阻断项 | 本轮结论 | 独立证据与界限 |
| --- | --- | --- |
| B1：生产入口不构造 relay client | 原入口缺线已修复；generation 生命周期未完成，见 R2 | [ui.tsx](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/ui.tsx:148)、[psp.tsx](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/psp.tsx:65) 均调用 createMapForHost；entry 测试 4/4，TCP thread/process 测试 2/2。无 lane 回退仍成立。native lane 缺失不作为本次 FAIL 理由。 |
| B2：search 未迁移、缺少 subscribe | 原阻断已消除 | [model search/markers](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/model.ts:96) 使用 relayJsonLoad；[streamFor](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/relay.ts:126) 先 OPEN、subscribe，再允许 GET；authority 只向已订阅 stream 发 INVALIDATE/PUSH，unsubscribe 后无后续通知。详见资源边界表和 mutation。 |
| B3：codec-1 非严格 UTF-8、异常逸出 | 原阻断已消除 | [utf8DecodeStrict](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/shared/relay.ts:193) 拒绝非法 lead、continuation、truncation、overlong、surrogate 和越界码点；[relayJsonLoad](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/app/relay.ts:478) 捕获 MapDecodeError。独立 loader callback 的 8 个非法输入全为 INVALID，0 逸出，1 test / 18 expectations 通过。 |
| B4：错误码取决于英文文本 | 原阻断已消除 | [failureCode](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/shared/failure.ts:36)、[coded dispatcher](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/host/capability.ts:39)、[authority error terminal](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/host/relay-host.ts:291) 传递声明 code；静态审计计得 34 个 coded failure constructors。英语、法语及带 budget/invalid 的 NOT_FOUND 均保持 code；BUSY 本地化保持 BUSY；普通 Error/非法 code 回退 DEADLINE；无方法为 UNSUPPORTED。 |
| B5：SIGHUP 后 discovery 与 authority 分裂 | 旧双 worker split 已消除；连续 replacement 未通过，见 R1 | [refresh](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/host/relay-host.ts:149) 先向新 backend 读完所有 map.info，再在同步段一起发布 backend/sources/catalog；[SIGHUP](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/host/serve.ts:45) 读新 config 并更新 worker。一次 replacement 的独立回归 2 帧得到 catalog、1 PUSH、0 NOT_FOUND、4 tiles、0 protocolErrors。 |
| B6：authority / L2 fence 时序 flake | 在本次重复门禁中未复现，旧阻断已消除 | [backend barrier](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/test/relay-rig.ts:139) 跟踪可完成 capability promise；[settle](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/test/relay-host.test.ts:44) 等待 backend idle 且本轮无新增 frame。authority 20/20 次通过，每次 11 tests；authority+model 20/20 次通过，每次 18 tests。 |

B3 的文字需校正：“no input produces U+FFFD”过宽。独立 [strict-json.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/reviewer/strict-json.log) 证明非法序列不经 replacement 接受；合法 UTF-8 EF BF BD **应当且确实**保留 U+FFFD。该文字问题不新增产品阻断。B6 的 helper 仍调用 drainMicrotasks(4)，其他 rig 路径也有有限次 microtask drain；通过结论针对已测 backend barrier 和 40 次结果，不宣称任意异步拓扑都不受调度影响。authority 每进程耗时 1.635–1.993 s；authority+model 12.558–13.054 s，详见 [determinism/summary.json](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/determinism/summary.json) 及 40 份原始日志。

**资源操作、配置与回退边界。**

| 资源 | relay identity / 操作 | 验证 |
| --- | --- | --- |
| raster tile | TILE，`map/<source>`，z/x/y，r5g6b5-v1；resource.get / ifRevision | chunked bytes 与 offload 解码结果相等；CANCEL 与 revision fence 有终态 |
| mesh | TILE，同一 ns/key，mesh-shortbread-v1；resource.get | PMH1 字节与原 map.mesh 相等 |
| markers | TILE，同一 ns/key，`markers-<layer>-v1`；resource.get | codec-1 rows 与原方法相等；namespace INVALIDATE 使条目失效 |
| search | EVENT，`map/<source>`，规范化 query/坐标 tuple，search-places-v1；resource.get | [authority mesh/markers/search test](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/test/relay-host.test.ts:126) 验证结果与原 map.search 相等 |
| catalog（原 map.info） | EVENT，map/catalog，maps，map-catalog-v1；get / conditional get / latest-snapshot PUSH | [catalog test](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/test/relay-host.test.ts:221) 验证新 catalog 通知与条件请求 |
| label | TEXTURE，`map/<source>`，文本 JSON pair；resource.get | 16,384 B 标签与原 map.label 相等 |

[shared identities](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/shared/relay.ts:98) 定义上述边界。每个使用中的 namespace 先建立 latest-snapshot subscription；subscription 的作用是绑定 PUSH / INVALIDATE。[subscriptionsFor](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/host/relay-host.ts:180) 检查 subscriptionsOn(stream)，[subscription delivery test](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/test/relay-host.test.ts:182) 验证只 OPEN 的 stream 收到 0 次通知、unsubscribe 后再次 revision move 收到 0 次通知。屏幕回归断言 relay 模式下跨 offload 的 map.* 方法集合为空。

[SAVED_PLACES_ONLY](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/host/capability.ts:14) 只有 bookmarks.list / bookmarks.command；[worker allowlist](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/host/worker.ts:12) 拒绝 relay host 辅助 worker 上的 map.info 和 map.tile。[真实 worker 测试](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/test/relay-host.test.ts:337) 验证两项 UNSUPPORTED、书签读取成功。host 仍支持 --offload / --relay 和 config.transport，guest 未发现 lane 时走原 offload 路径。TCP thread/process 两种 worker 各验证 catalog、search 及 131,072 B tile；错误 pairing key 在 HELLO 前被拒绝，authority 每次 gets=3 / objects=3 / opens=2，channel oversized=0。

L0 合同限制为 complete record 16,384 B、每方向 8 slots / 65,536 B、每帧 2 次 delivery / 2 次 submission、guest 一个固定 scratch。[channel 合同](/home/tangollvm/.fleet/worktrees/task-1204/contracts/spec/relay-channel.ts:16)、channel admission mutation 和真实 TCP 测试支持这些 JS/合同边界。rg -n -F relayChannel hosts/ 输出为空（exit 1），[docs/RELAY.md](/home/tangollvm/.fleet/worktrees/task-1204/docs/RELAY.md:604) 写明 native publisher 数量为 0；3DS/PSP 仍回退 offload。本次不验收未来的 native lane、native assembler、实体硬件帧率或截图。

**Pocket Map 独立命令和结果。**

map package 只有组合 check 脚本；分运输门禁采用显式测试文件列表并分别追加同一个 tsc --noEmit。未运行会递归发现 runtime tests 的裸 bun test。

```sh
cd "/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map"
bun test --conditions=browser test/geo.test.ts test/provider.test.ts test/model.test.ts test/bookmarks.test.ts test/transport.test.ts test/atlas.test.ts test/navigation.test.ts test/vector.test.ts test/sd.test.ts test/storage-benchmark.test.ts
runtime/node_modules/.bin/tsc --noEmit
bun test --conditions=browser test/relay-host.test.ts test/relay-model.test.ts test/relay-transport.test.ts test/relay-entry.test.ts
runtime/node_modules/.bin/tsc --noEmit
bun run check
```

| 门禁 | 原始日志 | 独立结果 |
| --- | --- | --- |
| offload | [check-offload.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map-results/check-offload.log)、[tsc-offload.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map-results/tsc-offload.log) | 28 pass / 0 fail / 1,037 expectations / 10 files；Bun 5.98 s；tsc exit 0 |
| relay | [check-relay.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map-results/check-relay.log)、[tsc-relay.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map-results/tsc-relay.log) | 24 pass / 0 fail / 311 expectations / 4 files；Bun 13.18 s；tsc exit 0 |
| 组合 check | [check-all.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map-results/check-all.log) | 52 pass / 0 fail / 1,348 expectations / 14 files；Bun 19.03 s；含 tsc 总耗时 21.511 s，exit 0 |
| 时序重复 | [repeat.py](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/repeat.py)、[summary.json](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/determinism/summary.json) | 同一 authority 命令运行 20 次；authority+model 命令运行 20 次；40/40 exit 0 |

可用 python3 V/map-checks.py 和 python3 V/repeat.py 复现整组命令；脚本保存每次原始输出。

**同一视口的逐瓦片字节及整屏开销。**

独立命令 bun --conditions=browser screen-bytes.ts（cwd V）对两个 transport 的四个可见 key 逐个比较：14/2621/6332、14/2621/6331、14/2620/6332、14/2620/6331。[screen-bytes.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/reviewer/screen-bytes.log) 保存每个配对 SHA-256：四个 raster payload 各 **131,072 B**，四个 mesh payload 各 **1,588 B**，八个 Buffer.compare 均为 0；key 也相同。model 测试另比较 16,384 B label 和 vector 的 32 条 marker rows。上述证明是 fixture 数据/材质输出相等，不外推为实体设备截图结果。

| 同屏项目 | raster offload | raster relay | vector offload | vector relay |
| --- | ---: | ---: | ---: | ---: |
| requests / GET | 10 | 10 | 14 | 14 |
| relay objects | — | 10 | — | 14 |
| image / mesh replies | 9 / 0 | — | 1 / 8 | — |
| 总 wire bytes | 1,066,632 | 1,088,330 | 33,551 | 49,271 |
| 每个可见瓦片摊销 wire bytes（总数除以 4） | 266,658 | 272,082.5 | 8,387.75 | 12,317.75 |
| downloads | 8 | 8 | 8 | 8 |
| HTTP / decoded cache hits | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| prepared hits | 0 | 0 | 4 | 4 |

摊销数包含预取、catalog、label、markers 和协议帧，不是单个 tile payload。raster relay 增量 **21,698 B / 2.034254%**；vector 增量 **15,720 B / 46.854043%**。raster 的 94 帧 = 10 REQUEST + 26 RESPONSE chunks + 46 CREDIT + 12 control；其中向 guest 1,079,889 B、向 provider 8,441 B，object data 1,065,205 B。vector 为 78 帧 = 14 REQUEST + 14 RESPONSE + 38 CREDIT + 12 control，object data 31,410 B。[measurements.json](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/measurements.json) 从 standalone relay 与组合 check 各抽出七组 relay receipts，七组相等；offload burst 的时间相关计数不作为跨运行常量。

**重连、revision、一次 replacement 与 L2 fence 的通过证据。**

[relay model receipts](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map-results/check-relay.log) 中，显式 disconnect/reconnect 的两个 session 对 8 个 resident entries 加 catalog 作 9 次 revalidation：9 notModified、0 object transfer、22 frames、11,839 B、0 RESYNC；每次 revalidation 平均 1,315.444 B，receipt 四舍五入为 1,315 B。此结果不覆盖 R2 的 positive → positive 入口转换。

revision 42e970c4765b3e6f → f4acc6e8d2680563：reload 时 3 个 in-flight GET，3 个 CANCELLED 终态；1 INVALIDATE；8 个 object refetch；6 个可见 tile 检查；14 resident；0 notModified。一次 source replacement 的 source 为 305f2b6a251eefcd → 7dd3bdef20131e3c，catalog 为 fdbe0158889f20a9 → 35344753f97a0cfc：2 帧到 catalog，1 PUSH，0 NOT_FOUND，4 tile 检查，8 resident，0 protocolErrors。R1 说明不能由一次 replacement 推出可重复刷新。

[L2 fence test](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/map/test/relay-host.test.ts:252) 让 revision 移动后才生成旧 revision 的 3 个 response chunks；结果为 RESYNC_REQUIRED，不发布本地 entry，请求及 GET assembly 清空，仅保留 subscription reservation。该测试在两组 40 次重复中均通过。

**600+ tile burst 的界限与所有 GET 终态。**

| 指标 | provider delay 0 | provider delay 3 | 验收解释 |
| --- | ---: | ---: | --- |
| 视口 jumps / distinct tiles / frames | 198 / 1,019 / 966 | 198 / 1,019 / 966 | 每组超过 600 个 GET |
| GET | 607 | 606 | 含 catalog |
| objects / CANCELLED / other errors | 607 / 0 / 0 | 212 / 394 / 0 | 每个 GET 恰有一个终态，合计分别 607、606 |
| provider → guest sent / received frames | 2,460 / 2,460 | 1,667 / 1,667 | 0 丢帧 |
| guest → provider measured / sent frames | 3,051 / 3,051 | 2,258 / 2,258 | 0 丢帧 |
| 最大 provider in-flight frames / bytes | 5 / 199,108 | 5 / 199,108 | 在分配 slice 5 / 208,896 内，也低于原验收上限 6 / 229,376 |
| 最大 guest active / provider active / demand | 3 / 3 / 6 | 4 / 3 / 2 | pending 上限 8，reserve 2 |
| peak staged / assembly scratch bytes | 1 / 536,576 | 1 / 536,576 | scratch ≤ 544,768 |
| 最终 resident entries / subscriptions | 40 / 2 | 40 / 2 | 含两个持续订阅 |
| end pending / staged / GET assemblies / provider demand / protocolErrors | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 | 无请求遗留 |
| 总 wire bytes | 80,768,360 | 28,479,101 | 两个独立固定延迟场景 |

两组都发出 591 个 CANCEL。delay 0 有 591 个 object 在取消后被丢弃，delay 3 为 197 个，故不能将每个 CANCEL 解释为节省一次传输。通过结论是流控界限、无丢帧和请求终态，未宣称零浪费。原始完整收据在 check-relay.log / check-all.log，提取值在 measurements.json。

**七项指定变异已全部独立重跑并命中指定测试。**

命令与 exact patches 由 [mutations.py](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/mutations.py) 保存；所有变异只作用于 disposable map/runtime snapshot，日志、原始 hash、restored=true 和完整测试名在 [mutation/summary.json](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/mutation/summary.json)。

| 变异 | 命令（在对应 snapshot） | pass / fail | 指定杀死测试 |
| --- | --- | ---: | --- |
| ifRevision 无条件命中 | bun test --conditions=browser test/relay-host.test.ts test/relay-model.test.ts | 15 / 3 | authority conditional GET；subscribed revision reload；moved-revision model |
| 不检查 INVALIDATE subscription | bun test --conditions=browser test/relay-host.test.ts | 10 / 1 | “a reloaded source revision reaches subscribed streams only…” |
| 删除 UTF-8 surrogate 检查 | 同上 | 10 / 1 | “codec 1 is decoded as strict UTF-8…” |
| 删除 UTF-8 overlong 检查 | 同上 | 10 / 1 | 同一严格解码测试 |
| failureCode 总返回 fallback | 同上 | 6 / 5 | 声明 code 的 dispatch、wire、worker allowlist、codec 和 mesh/search 错误断言 |
| 删除 channel 每帧 admission 上限 | bun test tests/relay-channel.test.ts | 5 / 1 | “sends are bounded per frame and by the host's credit; a detached lane is offline” |
| subscription 使用协商 ceiling 预留 scratch | bun test tests/relay-resource.test.ts | 68 / 1 | “a subscription reserves the push scratch it accepts, not the negotiated ceiling” |

七项均 exit 1 且 named_tests_killed=true；restore 校验 7/7。测试对上述改变有检测能力，但未覆盖 R1/R2。

**Runtime 的独立 M1 门禁。**

以下命令在 R 执行；bun run gen 另在 disposable runtime snapshot 执行以保持原始检出不变。cargo 使用现有 PATH；完整 suite 只覆盖环境 MGBA_PREFIX=/tmp/mgba-prefix。

| 命令 | 输出 / 结果 | 原始日志 |
| --- | --- | --- |
| MGBA_PREFIX=/tmp/mgba-prefix bun tools/test.ts | test: 14/14 stage(s) green in 167.4s；exit 0 | [suite-standard.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/suite-standard.log) |
| bun tests/contract.ts | contract: all green；spec.rs、pocket_spec.h、relay constants、relay generated.rs、package exports 均匹配 | [contract.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/contract.log) |
| bun run gen（snapshot） | exit 0；spec.rs、relay generated.rs、package.json 的生成前后 SHA-256 相等 | [gen-drift.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/gen-drift.log) |
| bun tools/tape.ts replay hero-main tests/tapes/hero-main.tape.json --assert tests/tapes/hero-main.hashes.json | tape: OK — 180 frames match | [tape.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/tape.log) |
| bun test tests/relay-frame.test.ts tests/relay-frame-c.test.ts | 19 pass / 0 fail / 5,858 expectations | [ts-c-vectors.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/ts-c-vectors.log) |
| cc -std=c11 -Wall -Wextra -Werror -Ihosts/shared -c hosts/shared/relay_frame.c -o V/runtime/relay_frame.o | exit 0，0 B compiler output | [c-warnings.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/c-warnings.log) |
| cargo test --manifest-path engine/Cargo.toml -p pocket-relay | 27 unit + 8 constants + 10 vectors + 1 doc = 46 pass；4 throughput ignored | [rust-std.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/rust-std.log) |
| cargo test --manifest-path engine/Cargo.toml -p pocket-relay --no-default-features | 同为 46 pass，4 throughput ignored | [rust-no-std.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/rust-no-std.log) |
| cargo check --manifest-path engine/Cargo.toml -p pocket-relay --target wasm32-unknown-unknown | exit 0 | [rust-wasm32.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/rust-wasm32.log) |
| bun test tests/npm-package.test.ts | 4 pass / 0 fail / 27 expectations | [npm-exports.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/npm-exports.log) |

TS、C、Rust 使用同一 48-vector corpus：23 legal、20 frame-layer rejects、5 upper-layer-only。C 的 JSON/envelope 语义由上层负责，不能把 C frame 接受那 5 项记为协议接受。[static-audit.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/reviewer/static-audit.log) 核对 9/9 subpaths（tile-viewport、resource-pack 及 7 个 relay subpaths），并从 map 的真实 package 链路导入 createTileCamera、createPackedImageCollection：两者 typeof=function，RELAY_CHANNEL.recordBytes=16384。tests/fixtures/relay/constants.json、engine/core/src/spec.rs、engine/crates/pocket-relay/src/generated.rs 与旧 pin f1ddc777 的字节也相同。

保留了一次 Reviewer 环境错误的 [runtime/suite.log](/home/tangollvm/.fleet/worktrees/task-1204/.pocket-build/validation/task-1204/20260920T220710Z/runtime/suite.log)：设置 CARGO_TARGET_DIR 后编译产物不在 suite 脚本的固定 wasm 路径，exit 1；去掉该覆盖的标准命令 14/14 通过。该日志不计产品失败。早期 boundary exploratory logs 中的 Reviewer harness 诊断也标为 superseded；R1/R2 只引用最终确认日志。

**协议勘误记录。**

[docs/RELAY.md Draft errata](/home/tangollvm/.fleet/worktrees/task-1204/docs/RELAY.md:787) 已给出五条正式记录：§3.5 本地 revisionless generation key 与 wire revision 的区别；§3.6 INVALIDATE 的 scope/namespace/reason 在 args 中；§3.6/§3.7 由 authority 检查 subscription delivery；§3.7 push scratch 按 subscription 接受的上限预留；§3.7 现阶段 JS assembly。源码 identity/schema/authority 路径与记录相符，runtime suite 中 prose gate 为 2 pass。B3 严格 UTF-8 和 B4 code 来源已改实现，未用勘误掩盖这两项原不符合。

**交付与后续边界。**

本 task 只向 Git 新增此 Reviewer findings；测试脚本、反例、raw logs、收据与编译输出位于 Git 忽略的 V 下并登记为 artifacts，未修改产品代码，未 push、未创建 PR。原 Builder map/runtime 分支的 git branch -r --contains HEAD 输出为空；这只证明本地已有远端引用不包含 tip，不单凭该命令证明远端从未存在 PR。报告使用独立 verify: 提交。

M2 目前未达到跨族 Reviewer 通过门。后续只需处理 R1 的 namespace/stream 退休及 R2 的 attachment 换代，在固定新 commits 上重跑两个反例和相关原门禁，再进行独立复核；当前不进入“Reviewer PASS 后停在人审”的状态，不将 native 3DS/PSP lane 新增为本次修复要求。

FAIL
