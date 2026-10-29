# AGH 插件装载与工具链执行证据

- 生成时间：2026-10-03T13:41:55.993Z
- 运行环境：Node v24.21.0 / win32-x64
- AGH 仓库：`C:\Users\86150\WorkBuddy\2026-10-03-20-48-23\agnes-harness`
- 复现命令：`tsx tools/agh-integration.mjs`（在 AGH 仓库根目录内执行）
- 断言：**55/55** 通过；事件账本 87 条

## 使用的 AGH 本体模块

- `packages/package-manager/src/plugin-manifest.ts (parseAgnesPluginEntries)`
- `packages/cordis/src/index.ts (Context / Fiber 生命周期与依赖注入)`
- `packages/extension-api/src/index.ts (checkToolDef / checkToolMeta)`
- `packages/protocol/src/validate.ts (validateAgainst)`

## 工具装载结果

| 工具 | 名称合法 | 描述长度 | 定义校验 | 元数据校验 | 只读 | 需审批 |
| --- | --- | --- | --- | --- | --- | --- |
| `vericite_corpus_overview` | ✓ | 109 | ✓ | ✓ | true | never |
| `vericite_search` | ✓ | 143 | ✓ | ✓ | true | never |
| `vericite_fetch_span` | ✓ | 93 | ✓ | ✓ | true | never |
| `vericite_verify_claim` | ✓ | 203 | ✓ | ✓ | true | never |
| `vericite_check_quote` | ✓ | 68 | ✓ | ✓ | true | never |
| `vericite_split_claims` | ✓ | 79 | ✓ | ✓ | true | never |
| `vericite_audit` | ✓ | 179 | ✓ | ✓ | true | never |
| `vericite_error_catalog` | ✓ | 50 | ✓ | ✓ | true | never |

## 工具调用链

1. `vericite_corpus_overview`
2. `vericite_search`
3. `vericite_fetch_span`
4. `vericite_split_claims`
5. `vericite_verify_claim`
6. `vericite_check_quote`
7. `vericite_audit`
8. `vericite_error_catalog`
9. `vericite_audit_positive`

## 断言明细

| 断言 | 结果 | 说明 |
| --- | --- | --- |
| 插件清单可被 AGH 解析 | ✅ | 解析出 1 条声明 |
| 声明了扩展入口导出名 | ✅ | export=vericitePlugin |
| 声明了插件 id | ✅ | id=ext:vericite/provenance |
| 声明了 extension 注入依赖 | ✅ | inject=["extension"] |
| 清单声明的导出在模块中真实存在 | ✅ | typeof=function |
| 模块导出与静态声明的注入依赖一致 | ✅ | module=["extension"] / manifest=["extension"] |
| 插件在 AGH 的 Cordis 运行时中装载成功 | ✅ | 工具数=8 |
| 注册了预期数量的工具 | ✅ | 实际 8 个：vericite_corpus_overview, vericite_search, vericite_fetch_span, vericite_verify_claim, vericite_check_quote, veri |
| 注册了 session_start 观察钩子 | ✅ | session_start |
| 工具定义通过 AGH 校验：vericite_corpus_overview | ✅ | ok |
| 工具元数据通过 AGH 校验：vericite_corpus_overview | ✅ | ok |
| 工具定义通过 AGH 校验：vericite_search | ✅ | ok |
| 工具元数据通过 AGH 校验：vericite_search | ✅ | ok |
| 工具定义通过 AGH 校验：vericite_fetch_span | ✅ | ok |
| 工具元数据通过 AGH 校验：vericite_fetch_span | ✅ | ok |
| 工具定义通过 AGH 校验：vericite_verify_claim | ✅ | ok |
| 工具元数据通过 AGH 校验：vericite_verify_claim | ✅ | ok |
| 工具定义通过 AGH 校验：vericite_check_quote | ✅ | ok |
| 工具元数据通过 AGH 校验：vericite_check_quote | ✅ | ok |
| 工具定义通过 AGH 校验：vericite_split_claims | ✅ | ok |
| 工具元数据通过 AGH 校验：vericite_split_claims | ✅ | ok |
| 工具定义通过 AGH 校验：vericite_audit | ✅ | ok |
| 工具元数据通过 AGH 校验：vericite_audit | ✅ | ok |
| 工具定义通过 AGH 校验：vericite_error_catalog | ✅ | ok |
| 工具元数据通过 AGH 校验：vericite_error_catalog | ✅ | ok |
| 参数校验（AGH validateAgainst）vericite_search 接受 {"query":"幻觉 归因"} | ✅ | expected=true actual=true |
| 参数校验（AGH validateAgainst）vericite_search 拒绝 {} | ✅ | expected=false actual=false |
| 参数校验（AGH validateAgainst）vericite_search 拒绝 {"query":"x","extra":1} | ✅ | expected=false actual=false |
| 参数校验（AGH validateAgainst）vericite_search 拒绝 {"query":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | ✅ | expected=false actual=false |
| 参数校验（AGH validateAgainst）vericite_search 拒绝 {"query":42} | ✅ | expected=false actual=false |
| 参数校验（AGH validateAgainst）vericite_verify_claim 接受 {"claim":"RAG 能降低幻觉"} | ✅ | expected=true actual=true |
| 参数校验（AGH validateAgainst）vericite_verify_claim 拒绝 {"claim":"x","k":999} | ✅ | expected=false actual=false |
| 参数校验（AGH validateAgainst）vericite_fetch_span 接受 {"span_id":"arxiv:2305.00001::100-200"} | ✅ | expected=true actual=true |
| 参数校验（AGH validateAgainst）vericite_fetch_span 拒绝 {} | ✅ | expected=false actual=false |
| 参数校验（AGH validateAgainst）vericite_audit 接受 {"text":"测试文本。","k":8} | ✅ | expected=true actual=true |
| 参数校验（AGH validateAgainst）vericite_audit 拒绝 {"text":"测试文本。","model_verdicts":[{"claim_id":"C001"}]} | ✅ | expected=false actual=false |
| 参数校验（AGH validateAgainst）vericite_split_claims 接受 {"text":"一句话。"} | ✅ | expected=true actual=true |
| 参数校验（AGH validateAgainst）vericite_split_claims 拒绝 {"text":1} | ✅ | expected=false actual=false |
| 参数校验（AGH validateAgainst）vericite_error_catalog 接受 {} | ✅ | expected=true actual=true |
| 参数校验（AGH validateAgainst）vericite_error_catalog 拒绝 {"unexpected":true} | ✅ | expected=false actual=false |
| 语料边界工具返回语料指纹 | ✅ | 1683c77844952b8b598dcbc4edfb71f29741dc54e7e00696f0b562d12293fec3 |
| 检索步骤返回带 span_id 的候选证据 | ✅ | 6 条 |
| 取回的原文与语料切片逐字一致（可回溯） | ✅ | verbatim_matches=true |
| 规划步骤拆出可核查主张 | ✅ | 1 条 |
| 确定性核验给出判定与指标 | ✅ | supported |
| 引文失真被检出 | ✅ | similarity=0 |
| 无依据的结论被拒绝输出 | ✅ | decision=REFUSE |
| 拒绝时给出结构化错误码 | ✅ | E_UNSUPPORTED_NUMERIC |
| 拒绝时不产生对外结论 | ✅ | output.kind=refusal |
| 错误码字典可被查询 | ✅ | 17 条 |
| 有原文依据的结论被放行且逐条附带引用 | ✅ | kind=verified_summary citations=2 |
| 卸载后工具随 fiber 一并回收（无残留能力） | ✅ | 剩余 0 个 |
| 插件可在一个全新的 Cordis 上下文中重新装载 | ✅ | 二次装载工具数=8 |
| 两次装载注册的工具集合完全一致（装载行为可复现） | ✅ | 第一次与第二次注册的工具名一致 |
| 二次装载的 fiber 同样能干净卸载 | ✅ | 剩余 0 个 |

## 说明

本脚本不连接模型、不启动 daemon，验证的是「插件在 AGH 装载契约下可用」。模型闭环需另配 Agnes 凭据。
