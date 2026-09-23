# O1：私有 REQUEST 发送面验证

实现提交：`2ee1e117687ca1252ede83a691f74242743178a6`（`feat(relay): negotiate and send private requests in both directions`）。基线：`04d198f8d733b1957da4623d40ec4c23db8c6a40`。分支：`fleet/task-1288`。

**guest 和 provider 均可在已 OPEN 的业务 stream 上发起已协商的私有 REQUEST。** 本次实现包含 8 个源码、测试和文档文件；报告由单独的 `verify:` 提交承载。未 push、未创建 PR。

## 接入结果

| 入口 | 行为与证据 |
| --- | --- |
| `RelayEndpointOptions.privateOps` | 本地登记 profile、`x.<profile.name>.<local-name>`、方向、args/value schema、wire/object 预算及恢复语义。最多 16 项、schema 安装资产最多 65536 字节。见 `framework/src/relay/private-op.ts:160`、`contracts/spec/relay.ts:295`。 |
| HELLO / OPEN | HELLO `opExt` 传描述符；profile/name/recovery 匹配，方向取交集、预算取最小。OPEN 绑定精确 profile 并收紧预算。schema 留在本地，无交集返回 `UNSUPPORTED`。见 `framework/src/relay/session.ts:938`、`framework/src/relay/session.ts:1059`。 |
| `request(stream, name, args, options?)` | 返回带 `correlation` 和 `cancel(reason?)` 的 Promise；await 得到一个 `{ok:true,value}` 或 `{ok:false,error,effect?}`。本地拒绝的 correlation 为 0。见 `framework/src/relay/endpoint.ts:386`。 |
| `onRequest` / `replyValue` / `replyError` | 两端使用相同 handler。`respond` 接受最多一个 accepted 和一个终态；相反方向可使用相同 correlation。见 `framework/src/relay/endpoint.ts:446`、`tests/relay-private-op.test.ts:180`。 |
| P3 准入 | schema 与字节预算先验证；再申请 request slot 和 credit。满窗返回 `BUSY`，已准入帧在传输忙时保留内容与 seq。见 `framework/src/relay/endpoint.ts:397`、`tests/relay-private-op.test.ts:388`。 |
| CANCEL | 使用既有 stream-0 sideband。重复 cancel 不增长重试队列；早于 REQUEST 的 CANCEL 存入 maxPending 有界表，并在 handler 前设置状态。见 `tests/relay-private-op.test.ts:300`、`tests/relay-private-op.test.ts:353`、`tests/relay-private-op.test.ts:373`。 |
| 断线与恢复 | idempotent 以 RESYNC_REQUIRED 结束；epoch/durable 以 OUTCOME_UNKNOWN、effect:unknown 结束。durable 要求 opEpoch/opId、value.receipt 和已协商 recoveryOp。发送面不自动重放。见 `framework/src/relay/endpoint.ts:525`、`tests/relay-private-op.test.ts:747`。 |
| TCP | `attachRelayProvider` 从 `endpoint.privateOps` 接入；`serveRelayTcp` 从顶层 `privateOps` 接入。真实 loopback socket 的双向请求测试通过。见 `tools/relay-wire.ts:112`、`tests/relay-private-op.test.ts:689`。 |

**公共前缀和 ResourceRef 保持封闭。** 产品 schema 限定 args/value，不向公共 metadata 添加自由字段。私有请求使用 codec 0、无 data 字节；需要分块的对象走资源 API。名字属于产品 profile，共享规格没有产品私有名字，没有新增 kind、codec 或依赖。

最终复查补入小预算边界：128 字节能容纳请求，但自动错误信封可能超限。修复前调用没有终态；修复后 endpoint 重置 stream，按恢复语义完成 pending calls。`tests/relay-private-op.test.ts:673` 覆盖没有 handler 和 handler 抛异常两条路径。无效应用回复仍返回错误并保留答复机会。

## 门禁结果

所有命令在仓库根目录执行，环境为：

```sh
export PATH="$HOME/.cargo/bin:$PATH" MGBA_PREFIX=/tmp/mgba-prefix
```

Bun 1.3.14，rustc 1.98.1，cargo 1.98.1，GCC 13.3.0。本地 `node_modules` 为指向 `/var/tmp/oss/pocketjs/node_modules` 的忽略软链。验证原始输出位于 `.pocket-build/validation/task-1288/run-1/`，以下日志名相对此目录。源码及所有列出的记录均已登记 Fleet artifact。

| 检查 / 复现命令 | 结果 | 记录 |
| --- | --- | --- |
| `bun test tests/relay-private-op.test.ts tests/relay-docs.test.ts` | **44 pass / 0 fail / 488 assertions**：42 项私有 op 测试、2 项文档测试 | `private-final-2.log` |
| `bun tools/test.ts --stage=unit` | unit：1123 pass / 6 条既有条件 skip / 0 fail；wasm host：237 pass / 0 fail。修复后重跑 | `suite-unit-final.log` |
| `bun test --conditions=browser tests/relay-sim-tape.test.ts` | 5 pass / 0 fail / 29 assertions；原缺 dist/hero-main.js 的一项已补跑 | `relay-sim-tape.log` |
| `bunx tsc --noEmit` | exit 0，零诊断 | `tsc-final-2.log` |
| `bun tests/contract.ts` | contract: all green | `contract-final.log` |
| `bun run gen` | exit 0，generated_drift=0 | `gen.log` |
| `bun tools/tape.ts replay hero-main tests/tapes/hero-main.tape.json --assert tests/tapes/hero-main.hashes.json` | **180 帧哈希全部匹配**，修复后重跑 | `tape-hero-final.log` |
| `cargo test --manifest-path engine/Cargo.toml -p pocket-relay` | 27 单测 + 8 常量 + 10 向量 + 1 doctest 通过，另 4 benchmark ignored | `rust-std.log` |
| 上一命令加 `--no-default-features` | 同样 46 项通过，另 4 benchmark ignored | `rust-no-std.log` |
| `cargo build --manifest-path engine/Cargo.toml -p pocket-relay --no-default-features --target wasm32-unknown-unknown` | exit 0 | `rust-wasm32.log` |
| 上一命令改为 `--target thumbv7em-none-eabi` | exit 0 | `rust-thumbv7em.log` |
| `cc -std=c11 -pedantic-errors -Wall -Wextra -Werror -fsyntax-only hosts/shared/relay_frame.c` | exit 0，零诊断 | `c-strict-final.log` |
| relay 12 个测试文件的联合运行，见下方命令 | 291 pass / 1 conditional skip / 0 fail / 247675 assertions；包括严格 C11、ASan/UBSan 向量检查。skip 后续补跑通过 | `relay-ts-c.log` |

```sh
bun test tests/relay-tape.test.ts tests/relay-endpoint.test.ts \
  tests/relay-sim-tape.test.ts tests/relay-session.test.ts \
  tests/relay-credit.test.ts tests/relay-frame.test.ts \
  tests/relay-channel.test.ts tests/relay-resource.test.ts \
  tests/relay-frame-c.test.ts tests/relay-private-op.test.ts \
  tests/relay-docs.test.ts tests/relay-wire.test.ts
```

联合运行记录在最后一项预算回归前生成；新增测试与 endpoint 的最终状态由 `private-final-2.log` 和 `suite-unit-final.log` 验证。6 条剩余 unit skip 属于 source-ending 的 4 项、legacy Apple wire 和 MIPS PRX 条件用例。

## 全套 16 阶段

`bun tools/test.ts` 在 AOT 阶段遇到失败会停止。先运行全套到该处，再按 `--stage='<完整阶段名>'` 跑其余阶段。**15 个阶段通过；AOT 阶段只有任务允许的 4 个上游既有失败。**

| 阶段 | 结果 | 记录 |
| --- | --- | --- |
| compiler smoke | PASS | `suite.log` |
| contracts drift guard | PASS | `suite.log` |
| unit | PASS，最终 1123 pass / 6 skip | `suite-unit-final.log` |
| unit (wasm host) | PASS，237 pass | `suite-unit-final.log` |
| handheld models and dual output | PASS，12 pass | `suite.log` |
| tape golden | PASS，180 frames | `suite.log`、`tape-hero-final.log` |
| AOT frontends and execution parity | 145 pass / 4 既有 fail | `suite.log` |
| Model AOT semantics and resources | PASS，244.7s | `suite-model-aot.log` |
| vue-sfc journeys | PASS，1 pass | `suite-vue-sfc.log` |
| clear journeys | PASS，16 pass | `suite-clear.log` |
| octane smoke | PASS，2 pass | `suite-octane.log` |
| cafe sim (determinism) | PASS，7 pass | `suite-cafe.log` |
| deepzoom sim | PASS，4 pass | `suite-deepzoom.log` |
| im sim | PASS，11 pass | `suite-im.log` |
| audio sim | PASS，2 pass | `suite-audio.log` |
| launcher sim | PASS，18 pass / 1014 assertions | `suite-launcher.log` |

在干净 upstream/main `b8d24230508c24555ed3f1eb9c18607befc8ecf9` 的隔离 worktree 运行 `bun tools/test.ts --stage='AOT frontends and execution parity'`（包括 stage prep），也得到 145 pass / 4 fail。`upstream-identity.log` 记录 `tracked_status=clean` 和 `matching_failures=4`；`upstream-aot-stage.log` 保留完整输出。四项名称如下：

- declaration preview imports share one context and signal module across parent and child
- uppercase views resolve lowercase basename declaration modules
- root factories export their context objects at module scope
- Solid and Rust agree frame by frame on keyed dispatch, owned events and lifecycle rounds

这些失败报告读取 `/var/tmp/oss/pocketjs/node_modules/@solid-primitives/keyed/dist/index.js` 的 `Unexpected reading file` / `EISDIR`。初次省略 prep 的直接测试记录 `upstream-aot.log` 不作为上游复现依据。

## 帧层逐字节证据

**8 个帧层源文件与基线逐字节相同。** `frame-identity-final.log` 保存每个文件的 SHA256；`verify-identity.py` 用 `git show <base>:<path>` 取基线字节，与工作区文件比较。运行：

```sh
python3 .pocket-build/validation/task-1288/run-1/verify-identity.py
```

| 语言 | 保持相同的文件 |
| --- | --- |
| TS（1） | `framework/src/relay/frame.ts` |
| C（2） | `hosts/shared/relay_frame.h`、`hosts/shared/relay_frame.c` |
| Rust（5） | `engine/crates/pocket-relay/src/{counters,frame,generated,lib,limits}.rs` |

实际结果：`frame_files_unchanged=8`，`legacy_vector_pairs=48 identical_files=96`，`index=identical constants_snapshot=identical`。没有新增 fixture。新机制在 TS 的 session/endpoint metadata 层实施，C/Rust 帧层继续只处理字节；no_std/无 alloc 核心没有变化。

## 变异与预算回归

在 `framework/src/relay/private-op.ts:243` 附近移除 `if (invalid) return { ok: false, code: RELAY_ERROR.INVALID };` 后运行：

```sh
bun test tests/relay-private-op.test.ts --test-name-pattern 'private schema rejects locally'
```

结果为 **1 fail / exit 1**：期望本地 `INVALID`，却收到远端 `UNSUPPORTED`，说明无效参数越过了发送侧检查。恢复后的 `private-op.ts` SHA256 为 `aad05fc4201487ecef0330fd3b1d3905c029a6b5cb90d8d281c274bc4776ec9d`，与实现提交一致。见 `mutation.log`。

小 wire 预算挂起用例修复前得到 `Expected length: 1 / Received length: 0`（`budget-terminal-before.log`），修复后两条分支都返回一个终态且双方请求 slot 归零（`private-final-2.log`）。

## 交付边界与 Fleet 记录

本任务交付 O1 私有发送面；不包含公共 `operation.status` / `operation.epoch` 的持久 receipt store，也不迁移 pocket-term。epoch 的去重字段、ACK 校验和 durable 的 receipt/query handler 仍由产品实现。结果未知时须查询或对账；该发送面不重发已准入写操作。

Fleet claims 8427–8438 分别记录登记、协商、双向 API、P3/预算、CANCEL、schema、恢复、测试变异、帧兼容、全套阶段、C/Rust 和附加门禁。实现文件 artifacts 为 14292–14299；验证记录 artifacts 为 14300–14340。本报告另行登记。没有委派子 agent，也没有外部 reviewer 结论；此报告是实现与运行验证记录。
