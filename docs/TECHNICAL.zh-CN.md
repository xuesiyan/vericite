# VeriCite · 科研文献溯源核查智能体

> 强制 AI 在给出**任何**文献结论时都提供原文依据；拿不出依据，就直接拒绝输出并报错。

参赛方向：**Agent 与 Harness 工程**（2026 年江苏省 AI+科学与工程创新实践黑客松 · 本科生组）

---

## 1. 要解决的问题

用大模型做文献总结时，最危险的不是"写得不好"，而是**写得很好但内容是编的**：

| 幻觉形态 | 为什么难发现 |
| --- | --- |
| **数值改写** | `38 个主题` 被写成 `83 个主题`。除了一个数字，其余字面几乎完全重合 |
| **强度越权** | 原文是 `may indicate`（可能表明），总结写成"证明了"。概念全对，话说满了 |
| **极性反转** | 多一个"不"字，语义完全相反，而逐词比对看起来"都对得上" |
| **张冠李戴** | A 论文的方法名安到 B 论文的结论上，读起来毫无破绽 |
| **引文失真** | 引用编号真实存在，但引文被截断取义或拼接改写 |
| **凭空引用** | 引用格式规范、编号连续，实际那条片段根本不存在 |
| **语料外作答** | 问题所依据的文献不在手上，模型用参数记忆补了一个"听起来合理"的答案 |

现有做法的根本缺陷：**用模型去验证模型**（LLM-as-a-judge）。这既不可复现（同输入不同输出），又是循环论证（幻觉的模型去审核幻觉），且判定理由无法回溯到原文。

## 2. 核心设计

### 2.1 三条判定原则（纯算法，无随机性）

- **P1 概念级覆盖**，而非词级重叠。一个中文术语对应一组英文候选（中英术语桥），命中任一即算覆盖；覆盖率的分子分母都按"概念单元"计算，避免同义词展开稀释分母。
- **P2 极性与相关性联动**。否定冲突只有在证据片段确实与主张相关（覆盖率达阈值）时才算"反证"；一个恰好含否定词但无关的片段不会误判。
- **P3 数值跨片段聚合**。主张中的每个数值，先在候选证据池内做替换检测（`38→83` 属于 **contradicted**），再看是否**任何**候选都未提及（属于 **insufficient**）。
- **P4 证据池污染不认证**。命中指令注入特征的片段被隔离；只要一条主张的证据池里出现过被隔离的片段，该主张**整体降级**，不予认证。

### 2.2 非对称双通道仲裁

| 通道 | 来源 | 性质 |
| --- | --- | --- |
| **A · 确定性核验** | `core/verify.mjs` | 纯算法，同输入必得同输出，可复现、可审计 |
| **B · Agnes 模型判定** | AGH 的 agent loop | 语义理解强，但有随机性 |

仲裁规则被刻意设计成**非对称**的：

> 模型通道可以让一条"看似合格"的主张被拦下（升级为人工复核），
> 但**永远无法**让一条被确定性通道否决的主张通过。

意义：把"是否放行"的最终否决权交给可复现的算法。系统不会因为模型的一次自信幻觉而输出未经证实的结论。

### 2.3 对外输出契约

```
decision = PASS       → 逐条输出结论，每条附带 span_id 引用（不得添加任何未被引用的额外结论）
decision = REFUSE     → 拒绝给出结论，如实报告触发的错误码与候选片段
decision = ESCALATE   → 不放行也不否决，同时呈现两条通道的判定，明确标注"需人工复核"
```

**不存在"把话说得更委婉以绕过核验"这条路径**——SKILL.md 里对模型有明文禁令。

### 2.4 span 级溯源

`span_id` 形如 `arxiv:2305.00012::14832-15001`，**直接编码原文字符区间**。
取回时按该区间对全文切片，返回的 `verbatim` 与 `text` 必须逐字一致，否则引用非法。任何引用都可以人工回到原文精确定位，不依赖系统自证。

## 3. 系统架构

```
                    ┌───────────────────────── AGH (Agnes Harness) ─────────────────────────┐
                    │  agent loop / 会话 / 工具调度 / 权限 / 执行记录                        │
                    └───────────────┬────────────────────────────────────┬───────────────────┘
                                    │ 装载插件（agnes.plugins）           │ 装载 Skill（.agh/skills）
                                    ▼                                    ▼
    ┌─────────────────────────── vericite 插件（8 个工具）──────────┐   ┌──────────────────────┐
    │ corpus_overview · search · fetch_span · verify_claim          │   │ lit-trace SKILL.md   │
    │ check_quote · split_claims · audit · error_catalog            │   │ 四阶段闭环操作规程   │
    └───────────────────────────────┬───────────────────────────────┘   │ + 硬性禁令 + 输出格式 │
                                    │                                    └──────────────────────┘
                                    ▼
    ┌──────────────────────────── 核验内核（纯算法，无外部依赖）────────────────────────────┐
    │ audit.mjs     主张拆解 / 闭环编排 / 非对称仲裁                                        │
    │ verify.mjs    IDF 加权概念覆盖 · 数值 · 极性 · 强度 · 实体 · 注入检测 · 引文校验      │
    │ lexicon.mjs   中英术语桥（受控双语映射，含保真度门槛）                                │
    │ corpus.mjs    BM25 检索 + HashMap 倒排索引 + span 索引（非可引用章节过滤）              │
    │ text.mjs      分句（保留字符偏移）· 分词 · 数值抽取 · 极性 · 强度 · 实体                │
    │ errors.mjs    17 个结构化错误码（severity / stage / meaning / handling）              │
    └───────────────────────────────┬──────────────────────────────────────────────────────┘
                                    ▼
    ┌──────────────────────────── 离线语料库（可复现的闭世界）───────────────────────────────┐
    │ 32 篇 arXiv 全文 · 26,092 个证据片段 · 1,999,114 字符 · 词表 22,954                  │
    │ 主题域：AI 幻觉 / 归因 / 检索增强 / 事实核查   sha256 1683c778…93fec3                 │
    └──────────────────────────────────────────────────────────────────────────────────────┘
```

找不到的片段、语料外的知识、被隔离的片段——**都不构成依据**。语料边界由 `corpus_overview` 显式声明，是每一步核查的起点。

## 4. 快速开始

环境要求：**Node ≥ 20**（本项目只在 Node 内置模块上运行，零运行时依赖）。

```bash
cd vericite

# 1) 查看语料边界（核查必须从这一步开始）
node cli.mjs corpus

# 2) 检索候选证据 → 取回原文核对（span_id 用上一步输出中的任意一条）
node cli.mjs search --query "retrieval augmented generation hallucination"
node cli.mjs span --id "arxiv:2401.00396::33184-33307"

# 3) 核查一段文本（正常样例：放行）
node cli.mjs audit --text "LongFact 包含 2280 条提示，覆盖 38 个人工选定的主题。RAGTruth 是一个大规模幻觉语料库，提供面向 RAG 场景的词级标注。"

# 4) 核查一段文本（数值篡改：拒绝）
node cli.mjs audit --text "LongFact 是一个提示集，包含 2280 条问题，覆盖 83 个主题。"

# 5) 跑全部样例并导出运行证据
node cli.mjs demo --all

# 6) 只要结果、失败即返回非零退出码（便于复核 / CI）
node tests/run.mjs

# 7) 可选：启用 Agnes 模型「第二意见」通道（需 Node ≥ 18 内置 fetch）
#    Key 只通过环境变量提供（AGNES_API_KEY），严禁写入代码、仓库或截图
AGNES_API_KEY=sk-*** node cli.mjs audit --text "……" --model --save out.json
```

### 4.1 模型第二意见通道（可选，默认关闭）

未设置 `AGNES_API_KEY` 时，系统行为与纯确定性通道完全一致——离线可复现。
设置后，`--model` 会在确定性判定完成后，把每条主张及其主证据片段发给 Agnes 官方网关
（OpenAI 兼容接口，`core/model-channel.mjs`，零依赖），请求一次封闭世界设定的第二意见：

- **封闭世界**：提示词明确禁止模型用自身知识补足证据，只允许判断「给出的证据是否支撑主张」；
- **非对称仲裁不变**：模型意见交由 `adjudicate()` 合并——模型可以让判定升级复核，
  但不能推翻确定性否决（实测证据：`evidence/model-channel-disagree.json` 中模型认为可放行，系统仍 REFUSE）;
- **失败降级**：网关超时/错误/额度耗尽时自动退回纯确定性通道，错误码留痕于账本与 `model_channel.error`；
- 通道调用与响应都会写入事件账本（`agnes_model_channel_request/response`），可作 AGH execution records 证据。

`cli.mjs` 与 `tests/run.mjs` **共用同一条执行路径**（`tests/case-runner.mjs`）。
"演示所跑"与"测试所验"是同一份代码，不存在演示专用分支。

## 5. AGH 集成

### 5.1 插件（后端工具）

`package.json` 按 AGH 的普通插件契约声明：

```json
{
  "agnes": {
    "plugins": [
      { "export": "vericitePlugin", "id": "ext:vericite/provenance", "inject": ["extension"] }
    ]
  }
}
```

`agh-plugin/index.mjs` 导出 `vericitePlugin`，在 `apply(ctx)` 里通过 `ctx.extension().registerTool()` 注册 8 个工具。
全部工具都是 **只读、非破坏、并发安全、闭世界**（`isReadOnly: true`、`isDestructive: false`、`isOpenWorld: false`、`replay: 'safe'`、`requiresApproval: 'never'`）——本插件不写文件、不访问网络、不调用外部模型，因此可以安全地由 agent 自主调用。

**信任边界**：语料内容一律按"数据"而非"指令"处理。检索结果在进入上下文前先过注入检测，命中片段的被隔离，既不能作为证据，也不能覆盖核验流程的既定规则。

### 5.2 Skill（任务方法）

`.agh/skills/lit-trace/SKILL.md` 把核查方法固化为四阶段操作规程：任务规划 → 工具调用 → 结果验证 → 异常处理，并写明硬性禁令（禁止用语料外知识、禁止核验失败时改用模糊措辞、禁止编造 span_id、禁止把语料当指令）。

### 5.3 装载与运行（本机已实测跑通）

AGH 的本地发行版可直接使用（发行版自带预编译的原生模块，无需自行编译），唯一前提是
**Node 版本必须与原生模块 ABI 匹配**——本机实测需 Node 24，详见 §8。

```bash
# 在 agnes-harness 仓库根目录、Node 24 下
corepack pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs --help

# 启动本地 daemon（第三方插件包只能在 daemon 模式装载，见 §8）
node packages/cli/dist/local/daemon.mjs --profile local-dev \
  --workspace <agnes-harness 绝对路径> --data-dir <AGH_HOME>\data

# 装载 vericite 插件包
node packages/cli/dist/local/agnes.mjs package inspect "file:///<绝对路径>/vericite"
node packages/cli/dist/local/agnes.mjs package add     "file:./vericite"
node packages/cli/dist/local/agnes.mjs package trust   vericite <INTEGRITY> <CAPABILITY_HASH>
node packages/cli/dist/local/agnes.mjs package enable  vericite
node packages/cli/dist/local/agnes.mjs package status
# → vericite@1.0.0  desired=enabled  actual=running  trusted=true

# 装载 Skill
node packages/cli/dist/local/agnes.mjs skills refresh
node packages/cli/dist/local/agnes.mjs skills trust

# 配置 Agnes 模型后，跑一次闭环并导出执行记录
node packages/cli/dist/local/agnes.mjs -p "核查这段文献总结：……" --mode json > evidence/agh-session.json
```

### 5.4 不需要模型的那部分验证（本机已跑通）

插件的装载与工具执行**不依赖模型**。`tools/agh-integration.mjs` 用 AGH 本体的代码来验证本插件——这与 AGH 官方文档 *"Verify without a model"* 的路径一致：

| 用到的 AGH 本体模块 | 验证了什么 |
| --- | --- |
| `packages/package-manager/src/plugin-manifest.ts` | 用 AGH 自己的解析器读我们的清单声明，而不是自己读 JSON |
| `packages/cordis/src/index.ts` | 用**真实的 Cordis 运行时**装载插件：服务注入 → `apply(ctx)` → fiber 释放时自动回收 |
| `packages/extension-api/src/index.ts` | `checkToolDef` / `checkToolMeta` 逐个校验 8 个工具的定义与元数据 |
| `packages/protocol/src/validate.ts` | `validateAgainst` 校验参数 schema，含 7 个反向用例（缺参、多参、类型错、超长、越界） |

结果：**断言 55/55 通过，事件账本 87 条**（证据：`evidence/agh-integration.json` / `.md`）。
这一步还真实暴露并修掉了一个插件缺陷：直接读未注入的服务 `ctx.log` 在严格 Cordis 上下文下会抛错，现已改为降级处理，保证"没有日志"不会变成"插件装载失败"。

### 5.5 真实 agent loop 的执行记录（本机已跑通）

在 daemon 模式下用 Agnes 模型跑了一次真实会话，3 轮全部 `reason: completed`，模型真实调用了本插件的工具：

| 轮次 | 提问意图 | 结果 | 耗时 |
| --- | --- | --- | --- |
| P1 | 列错误码（要求直调 `vericite_error_catalog`） | completed | 12.2 s |
| P2 | 核查含数值「72%」的文献总结 | completed | 20.5 s |
| P3 | 核查「量子纠缠可瞬时传信」 | completed | 8.8 s |

会话中共发生 11 次工具调用：9 次 `tool_search`（前 8 次均返回 `no matching tools`，第 9 次才命中
`vericite_audit` 的工具描述）+ **2 次 `vericite_audit` 真实调用**，两次均返回拒绝裁决：

| 主张 | 裁决 | 错误码 | 证据 |
| --- | --- | --- | --- |
| RAG 降低幻觉率 / GPT-4 在 LongFact 与人类一致率 72% | REFUSE | `E_UNSUPPORTED_NUMERIC` | 数值「72」在 `arxiv:2403.18802::2175-2374` 原文中不存在（`not_present_in_any_candidate`） |
| 量子纠缠可在宏观尺度实现瞬时信息传递 | REFUSE | `E_NO_EVIDENCE` | 最佳覆盖率 0.1111，最接近片段 `arxiv:2212.09577::66911-66994` 与主张无关 |

值得记录的是模型的最终答复：它明确区分了「工具输出的裁决」与「模型自身的独立判断」，并主动声明后者
不属于 VeriCite 的结论——这正是本系统"确定性通道优先、模型只作第二意见"设计意图的直接体现。

- 完整记录：`evidence/agh-session-daemon.json`（3 轮对话 + 56 条事件，含每轮工具入参与返回原文）
- 结构化摘要：`evidence/agh-session-daemon-summary.json`
- 可读报告：`evidence/agh-session-daemon-报告.md`

## 6. 验证与运行证据

| 证据文件 | 内容 |
| --- | --- |
| `evidence/run-latest.json` | 10 个样例的完整运行证据：逐条主张、证据片段、全部指标、错误详情 |
| `evidence/ledger.jsonl` | 逐步事件账本（对应 AGH execution records）：plan / tool_call / tool_result / verify / exception |
| `evidence/tool-call-chains.json` | 每个样例的工具调用链 |
| `evidence/summary.md` | 可读摘要（样例表 + 统计） |
| `evidence/agh-integration.json` | AGH 插件装载与工具链执行证据（55 项断言 + 87 条账本） |
| `evidence/agh-integration.md` | 上述证据的可读版 |
| `evidence/agh-session-daemon.json` | **真实 agent loop 执行记录**：3 轮会话、11 次工具调用（含 2 次 `vericite_audit`）与逐轮事件原文 |
| `evidence/agh-session-daemon-summary.json` | 上述会话的结构化摘要（工具调用、裁决、错误码） |
| `evidence/agh-session-daemon-报告.md` | 上述会话的可读报告（含插件装载审计日志原文） |
| `evidence/model-channel-agree.json` | 真实 Agnes 网关第二意见：双通道一致 → PASS（agnes-3.0-flash，2/2 agree） |
| `evidence/model-channel-disagree.json` | 真实分歧样本：模型认为可放行，确定性否决 → 仍 REFUSE（非对称仲裁实测） |

> `evidence/run-*.json` 是每轮运行的带时间戳快照，`run-latest.json` 始终指向最近一次；
> 保留历史快照是为了可复核"同一输入多次运行结论一致"，不参与提交评审的正文。

当前结果：

```
样例通过     10/10
断言通过     37/37
裁决分布     REFUSE×8   ESCALATE×1   PASS×1
覆盖错误码   8 类
```

### 测试样例（三类）

- **正常（1）** `normal-01`：全部主张可定位到支撑片段 → PASS，逐条给出 span 级引用
- **边界（5）** 数值篡改 / 强度越权 / 极性反转 / 引文失真 / 语料外主张
- **失败（4）** 伪造 span_id / 语料内指令注入 / 双通道判定冲突 / 空输入

每个样例都写明了**考察点**（`focus` 字段），并在 `evidence/summary.md` 里逐条说明"为什么这一类幻觉必须靠这个机制才能发现"。

## 7. 已知限制与边界

诚实交代系统的能力边界，比夸大更重要：

1. **闭世界**。只能在给定语料内核查。语料外的问题一律拒答——这是设计目标（避免用参数记忆补答案），不是缺陷。
2. **检索依赖词面**。BM25 是词面检索；跨语言（中文主张 → 英文文献）依赖受控中英术语桥，术语桥未覆盖的冷僻表述会走到 `E_CROSSLINGUAL_LOW_MAPPING`，此时系统选择拒答而不是猜测。
3. **阈值是工程折中**。`core/verify.mjs` 的 `THRESHOLDS` 全部集中在一个对象里并随证据一起导出，便于复核者质疑与调整；阈值不是"真理"，是显式声明。
4. **不判断论断本身的科学对错**。系统判断的是"这句话是否有原文依据"，不判断"原文是否正确"。
5. **模型通道只作第二意见**。`E_MODEL_CONFLICT` 的分歧会被记录并升级复核，但模型无法推翻确定性否决。

## 8. 本机环境的一处真实坑（已定位并解决）

AGH 的完整本地发行版已在这台开发机（Windows）上跑通，但过程中踩到一个**真实、可复现、
且错误信息具有误导性**的环境问题，如实记录：

```
Node 22（ABI 127）加载原生模块
  → E_SYSTEM_NATIVE_UNAVAILABLE: System module is missing or incompatible
    Rebuild Windows native artifact for the current Node.js/libuv runtime
  → daemon mutation lock unavailable: Windows native helper unavailable
  → daemon discovery file is unavailable or invalid

Node 24（ABI 137）加载原生模块
  → abiVersion = 1   ✅
```

**根因**：AGH 在 Windows 上依赖原生模块 `agnes-system.node`（用于创建受控 DACL 的私有目录、创建进程作业对象、
读写 daemon 的 `discovery.json`）。发行版自带的是**预编译产物**，其 ABI 与 **Node 24** 绑定；用 Node 22 启动时，
原生模块拒绝加载，上层便表现为"模块缺失"。**错误信息指向缺少模块，真实原因是 Node 版本 ABI 不匹配**——
这一点消耗了大量排查时间，因此专门写进文档。

**解法**：用 Node 24 运行 AGH 侧命令即可（本项目开发与验证使用 v24.21.0）。这属于运行环境的版本匹配问题，
与本项目代码无关。若确实需要从源码重编原生模块，按官方文档：

```powershell
# PowerShell，在 agnes-harness 仓库根目录
$ErrorActionPreference = 'Stop'
& .\.github\scripts\prepare-windows-native.ps1 -CacheRoot "$env:LOCALAPPDATA\node-gyp\Cache"
pnpm.cmd --filter @agnes/cli build:local
node .\packages\cli\dist\local\agnes.mjs --help
```

另有两个必须满足的前提：

1. **第三方插件包只能在 daemon 模式装载**。宿主装配要求每个 `enabled` 且 `trust !== builtin` 的包都具备
   不可变运行时快照（`runtimePluginSnapshots`），该快照只由 daemon 提供；`--standalone` 内嵌模式会在装配阶段
   直接报 `E_EXT_LOAD: trusted package has no immutable runtime snapshot`。因此本项目插件的装载必须走 daemon。
2. **AGH 的模型通道只能使用 Agnes 模型**，完整 agent loop 需要 Agnes 账号与模型路由。

满足上述前提后，本机已完成 daemon 模式下的真实 agent loop 会话记录（见 §5.5 与
`evidence/agh-session-daemon.json`）。

## 9. 目录结构

```
vericite/
├── cli.mjs                    命令行入口（演示 / 证据导出）
├── package.json               AGH 插件声明 + 脚本
├── agh-plugin/index.mjs       AGH 后端插件：8 个工具
├── .agh/skills/lit-trace/     AGH Skill：四阶段闭环操作规程
├── core/
│   ├── audit.mjs              主张拆解 · 闭环编排 · 非对称仲裁
│   ├── verify.mjs             判定原则 P1–P4 · 注入检测 · 引文校验
│   ├── lexicon.mjs            中英术语桥（受控双语映射）
│   ├── corpus.mjs             BM25 + 倒排索引 + span 索引
│   ├── text.mjs               分句 / 分词 / 数值 / 极性 / 强度 / 实体
│   └── errors.mjs             17 个结构化错误码
├── corpus/corpus.json         离线语料库（32 篇全文，sha256 已固定）
├── tools/
│   ├── build-corpus.mjs       从 arXiv 构建语料库
│   └── agh-integration.mjs    AGH 本体装载与工具链执行验证
├── tests/
│   ├── run.mjs                回归测试入口（失败返回非零）
│   ├── case-runner.mjs        与演示共用的执行路径
│   ├── cases/                 10 个样例（正常 / 边界 / 失败）
│   └── fixtures/              对抗性语料夹具（含指令注入）
├── evidence/                  运行与验证证据（生成物）
└── docs/                      项目说明 / 演示脚本 / 声明 / 素材来源
```

## 10. 第三方素材来源

- **语料**：32 篇 arXiv 论文全文，经 arXiv 官方 API 与 HTML 全文页获取。arXiv 内容遵循各论文自身许可（多为 arXiv.org perpetual non-exclusive license 或 CC-BY）。本项目仅用于学术竞赛的非商业演示与研究，**未做任何内容改写**，原文链接随语料一并保存（`corpus/corpus.json` 的 `sources` 字段），可按 `doc_id` 回溯核查。语料构建脚本见 `tools/build-corpus.mjs`，语料指纹 sha256 `1683c77844952b8b598dcbc4edfb71f29741dc54e7e00696f0b562d12293fec3`。
- **底座**：Agnes Harness（AGH），Apache-2.0。本仓库不修改 AGH 源码；AGH 侧验证脚本通过其公开模块调用。
- 本项目**不引入任何第三方运行时依赖**（仅使用 Node 内置模块），因而不存在依赖树污染或供应链风险。

---

## 复现一句话

```bash
cd vericite && node cli.mjs demo --all && node tests/run.mjs
```

同输入必得同输出——这正是本系统存在的意义：**让"这句话有依据吗"这个问题，有一个可复现的答案。**
