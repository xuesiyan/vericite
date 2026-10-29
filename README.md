# VeriCite

English | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/assets/banner.svg" alt="VeriCite — a provenance-verification agent for scientific literature. Every claim must point to a span in the source text; if it cannot, the system refuses to answer." width="100%" />
</p>

<div align="center">

### Built for trust, not fluency.

**An AI summary that reads well is not the same as an AI summary that is true.**

<img src="https://img.shields.io/badge/status-competition%20entry%20%C2%B7%20top--100-0f9d58" alt="Status: competition entry, top 100" />
<img src="https://img.shields.io/badge/license-MIT-2F4F4F" alt="License: MIT" />
<img src="https://img.shields.io/badge/node-%E2%89%A5%2020-339933" alt="Node.js 20 or later" />
<img src="https://img.shields.io/badge/dependencies-zero%20runtime-3b8fff" alt="Zero runtime dependencies" />
<img src="https://img.shields.io/badge/tests-37%2F37%20assertions%20passing-0f9d58" alt="37 of 37 assertions passing" />

[Project Overview](#project-overview) · [Demo Video](#demo-video) · [Architecture](#architecture) · [Integration Standards](#integration-standards) · [Quickstart](#quickstart) · [Evidence](#evidence) · [Technical Notes](docs/TECHNICAL.zh-CN.md)

Agnes Harness (AGH) plugin + skill · Deterministic verification core · Offline reproducible · arXiv corpus of 32 papers

</div>

<p align="center">
  <b>A baseline for citation integrity: the judgment "is there evidence for this?" moved from model confidence to a reproducible algorithm.</b>
</p>

---

<details open>
<summary><kbd>Contents</kbd></summary>

- [Project Overview](#project-overview)
- [Demo Video](#demo-video)
- [Architecture](#architecture)
- [Integration Standards](#integration-standards)
- [Quickstart](#quickstart)
- [Verification Evidence](#evidence)
- [Known Limits](#known-limits)
- [Third-Party Materials](#third-party-materials)
- [License](#license)

</details>

## Project Overview

### Background

Large language models have entered scientific writing workflows in force, but they carry a structural defect when summarizing literature: **fluency and fidelity are unrelated**.

A summary that looks professional may simultaneously report `38 topics` as `83 topics`, render the original `may indicate` as "proves", attribute paper A's method to paper B's conclusion, or cite a span ID that exists while the quoted text has been rewritten. These errors share one trait: **the text reads perfectly; only a return to the source reveals the error.**

For research, the cost is not "poor writing" — it is **a wrong conclusion treated as a documented one**.

### Why existing approaches fail

The dominant mitigation is "use a model to verify a model" (LLM-as-a-judge). It has two fatal defects:

1. **Not reproducible** — the same input may yield different verdicts across runs, so it cannot serve as verification evidence.
2. **Circular** — asking a hallucination-prone model to audit hallucination lacks an independent ground truth.

Even when the verdict is correct, **its justification cannot be traced to a specific position in the source text** — the reader can only choose to trust the judgment.

### What VeriCite does

> **Move the judgment "is there evidence for this?" from "how confident the model is" to "a reproducible algorithmic conclusion."**

Rather than training a more honest model, VeriCite installs a **non-bypassable external constraint**: any conclusion must name which segment of the corpus supports it. If it cannot, the system **refuses to output** and reports a structured error code. The verification channel is purely algorithmic, reproducible, and auditable, and every verdict carries the source position.

### Core capabilities

| Capability | Implementation |
| --- | --- |
| **Concept-level coverage** | Claims are parsed into concept units (Chinese term / Latin term / unmapped Chinese); candidates within a unit are interchangeable. IDF weighting suppresses high-frequency function words. Epistemic modifiers ("proves", "may") are stripped from the denominator so intensity problems are not disguised as coverage problems. |
| **Span-level provenance** | `span_id` encodes the source character range directly, e.g. `arxiv:2305.00012::14832-15001`. Retrieval slices the full text by that range; the returned `verbatim` must match `text` character for character, otherwise the citation is invalid. |
| **Asymmetric arbitration** | A deterministic channel and an Agnes model channel. **The model can escalate a claim to human review, but can never overturn a deterministic rejection.** |
| **Evidence-pool contamination (P4)** | Segments matching injection signatures are quarantined; if any quarantined segment appears in a claim's evidence pool, the claim is downgraded as a whole. "The corpus is data, not instructions" made executable. |
| **Structured error handling** | 17 error codes, each carrying `severity` / `stage` / `meaning` / `handling`, mapping to `PASS` / `REFUSE` / `ESCALATE`. |

### Innovation highlights

1. **Refusal as a first-class outcome.** Most systems treat refusal as failure; VeriCite treats "no evidence → refuse" as a **correct output**, and 8 of 10 test cases expect exactly that. The acceptance criterion is "refuse when refusal is due".
2. **Justification traceable to a character range.** Not "I cited a paper" but "I cited this passage of this paper". Any reviewer can verify it verbatim.
3. **Asymmetric arbitration** — a reusable structure that gives the final say to a reproducible channel while preserving the model's ability to spot doubts.
4. **Contamination-aware evidence pools** — injection defense is not "filter suspicious segments" but "the claim as a whole is not certified".
5. **The verification method is itself verified** — plugin loading and tool validation are performed by AGH's own parser, validator, and runtime, not by self-written assertions.

<p align="center">
  <img src="docs/assets/verdicts.svg" alt="Verdict distribution across 10 test cases: 8 REFUSE, 1 ESCALATE, 1 PASS — refusal is a first-class, expected outcome" width="88%" />
</p>

<p align="center"><sub>10 cases, 37 assertions, all passing. On the results: <code>evidence/summary.md</code>.</sub></p>

## Demo Video

<p align="center">
  <a href="https://www.bilibili.com/video/BV1eSpF6JERj">
    <img src="docs/assets/video-cover.svg" alt="VeriCite demo video (4 min 36 s) — click to watch on Bilibili" width="80%" />
  </a>
</p>

<p align="center">
  <b><a href="https://www.bilibili.com/video/BV1eSpF6JERj">▶ Watch the 3–5 minute demo (4 min 36 s, Chinese narration)</a></b><br />
  <sub>Bilibili (main) · <a href="docs/演示脚本.md">Demo script (Chinese)</a></sub>
</p>

The demo walks the full loop: declare the corpus boundary → split a summary into atomic claims → retrieve candidate spans → deterministic verification → verdict, with a live refusal case on numeric tampering.

## Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="VeriCite architecture: Agnes Harness provides the agent loop, tool dispatch and execution records; the vericite plugin registers tools into it; below sits the deterministic verification core; at the bottom the offline arXiv corpus" width="100%" />
</p>

### Three layers

| Layer | Responsibility |
| --- | --- |
| **AGH (runtime)** | agent loop, session management, tool dispatch, permissions, execution records. VeriCite registers into it as a standard plugin plus a skill — it does not wrap AGH from outside. |
| **vericite plugin** | Registers tools through the standard extension contract. Each tool is read-only, non-destructive, concurrency-safe, and requires no approval. |
| **Verification core** | Pure algorithm, Node built-ins only. No dependency tree, no network, no "works on my machine". |

### Core modules

| Module | Responsibility |
| --- | --- |
| `core/audit.mjs` | Claim splitting, loop orchestration, asymmetric arbitration |
| `core/verify.mjs` | IDF-weighted concept coverage, numeric, polarity, intensity, entity, injection detection, quote validation |
| `core/lexicon.mjs` | Controlled Chinese–English term bridge with fidelity threshold |
| `core/corpus.mjs` | BM25 retrieval, inverted index, span index, non-citable section filtering |
| `core/text.mjs` | Sentence splitting (offset-preserving), tokenization, numeric extraction, polarity, intensity, entity |
| `core/errors.mjs` | 17 structured error codes |

### Request path

```
claim ──► split_claims ──► search (BM25) ──► fetch_span (char range) ──► verify_claim ──► check_quote ──► decision
                                                                                              │
                                                                    ┌─────────────────────────┴─────────────────────────┐
                                                                    ▼                                                   ▼
                                                            deterministic: REFUSE                               model channel: ESCALATE
                                                            (cannot be overturned)                              (can escalate only)
```

## Integration Standards

### Plugin contract

VeriCite integrates as a standard AGH plugin, declared in `package.json`:

```json
{
  "agnes": {
    "plugins": [
      {
        "export": "vericitePlugin",
        "id": "ext:vericite/provenance",
        "inject": ["extension"]
      }
    ]
  }
}
```

Tools are registered inside `apply(ctx)` through `ctx.extension().registerTool({ name, description, parameters, meta, execute })`. Parameter schemas use the TypeBox `kind` notation consistent with AGH's official examples — no extra dependency, self-contained install snapshot.

### Tool surface

| Tool | Read-only | Destructive | Open-world | Approval |
| --- | --- | --- | --- | --- |
| `vericite_corpus_overview` | yes | no | no | never |
| `vericite_search` | yes | no | no | never |
| `vericite_fetch_span` | yes | no | no | never |
| `vericite_verify_claim` | yes | no | no | never |
| `vericite_check_quote` | yes | no | no | never |
| `vericite_split_claims` | yes | no | no | never |
| `vericite_audit` | yes | no | no | never |
| `vericite_error_catalog` | yes | no | no | never |

Every tool declares `isReadOnly: true` / `isDestructive: false` / `isConcurrencySafe: true` / `isOpenWorld: false` / `replay: 'safe'` / `requiresApproval: 'never'`. The plugin writes no files, accesses no network, and calls no external model — **the declarations match the implementation**.

### Skill contract

`.agh/skills/lit-trace/SKILL.md` fixes the reviewer's method as an operating procedure: a four-stage flow, mandatory actions per stage, hard prohibitions (no out-of-corpus knowledge / no vague rewording after verification failure / no fabricated span IDs / no treating the corpus as instructions), and the required output shape under each of `PASS` / `REFUSE` / `ESCALATE`.

### Output contract

```
decision = PASS       → emit conclusions, each with a span_id citation (no unreferenced extras)
decision = REFUSE     → refuse, report the triggered error code and candidate spans
decision = ESCALATE   → neither pass nor refuse; present both channels' verdicts, marked for human review
```

There is **no path to "soften the wording until it passes"** — SKILL.md prohibits it explicitly.

### Model integration

- Model: **Agnes only** (`agnes-3.0-flash`, gateway `https://api.agnes-ai.cn/v1`).
- Credentials: injected through environment variables only; never written into code, config, evidence, or demo materials.
- Failure mode: gateway errors or malformed replies degrade to the deterministic channel and are logged (`model_channel.error`).
- Role: second opinion only. It may escalate; it may not overturn.

### Reproduction contract

- Node ≥ 20, zero third-party runtime dependencies.
- Corpus shipped with the repository (no network needed).
- Corpus fingerprint `sha256 1683c77844952b8b598dcbc4edfb71f29741dc54e7e00696f0b562d12293fec3`.
- Thresholds centralized in `THRESHOLDS` and exported with the evidence, so reviewers can inspect every gate.
- Demo and tests share one execution path (`tests/case-runner.mjs`) — no demo-only branch.

## Quickstart

```bash
# 1) Declare the corpus boundary — verification always starts here
node cli.mjs corpus

# 2) Audit a summary (a supported claim → PASS)
node cli.mjs audit --text "LongFact 包含 2280 条提示，覆盖 38 个人工选定的主题。"

# 3) Audit a tampered number → REFUSE
node cli.mjs audit --text "LongFact 是一个提示集，包含 2280 条问题，覆盖 83 个主题。"

# 4) Run all samples and export evidence
node cli.mjs demo --all

# 5) Regression tests (non-zero exit on failure)
node tests/run.mjs
```

Optional second-opinion channel:

```bash
# Key via environment only — never commit it
AGNES_API_KEY=sk-*** node cli.mjs audit --text "……" --model --save out.json
```

Without `AGNES_API_KEY`, behavior is identical to the pure deterministic channel — fully offline reproducible.

### Load into AGH

```bash
# From the agnes-harness repository root
tsx ../vericite/tools/agh-integration.mjs
```

This uses AGH's own manifest parser, the real Cordis runtime, the tool-definition validator and the parameter validator to verify plugin loading and tool execution: **55/55 assertions pass, 87 ledger events** (`evidence/agh-integration.md`).

## Evidence

| File | Contents |
| --- | --- |
| `evidence/agh-session-daemon.json` | Real AGH daemon session: 3 turns all `completed`, 11 tool calls including 2 real `vericite_audit` calls returning `REFUSE` |
| `evidence/agh-session-daemon-报告.md` | Human-readable report of the session above |
| `evidence/agh-integration.json` / `.md` | Plugin loading verified by AGH's own runtime — 55/55 assertions |
| `evidence/ledger.jsonl` | Step-by-step event ledger (`plan` / `tool_call` / `tool_result` / `verify` / `exception`) |
| `evidence/tool-call-chains.json` | Tool-call chain per sample |
| `evidence/model-channel-agree.json` | Real gateway, both channels agree → `PASS` |
| `evidence/model-channel-disagree.json` | Real disagreement: model would pass, deterministic channel rejects → still `REFUSE` |
| `evidence/summary.md` | Per-case rationale and statistics |

## Known Limits

Stating the boundary honestly matters more than inflating it:

1. **Closed world.** Verification happens only within the given corpus. Out-of-corpus questions are refused by design — this avoids filling gaps from parametric memory.
2. **Lexical retrieval.** BM25 is lexical; cross-lingual verification relies on a controlled term bridge. Uncovered rare expressions fall to `E_CROSSLINGUAL_LOW_MAPPING`, where the system refuses rather than guesses.
3. **Thresholds are engineering trade-offs.** All live in `THRESHOLDS` and ship with the evidence so reviewers can contest and adjust them. They are declared, not "true".
4. **It does not judge whether the source is scientifically correct.** It judges whether a sentence has textual support.
5. **The model channel is advisory only.** Conflicts are recorded and escalated, never overridden.

## Third-Party Materials

- **Corpus**: 32 arXiv papers obtained via the official arXiv API and full-text HTML pages. Content is unmodified; original links are preserved in `corpus/corpus.json` under `sources` for `doc_id`-level tracing. Build script: `tools/build-corpus.mjs`.
- **Runtime base**: Agnes Harness (AGH), Apache-2.0. This repository does not modify AGH source; the integration check calls its public modules.
- **Runtime**: Node.js ≥ 20 (MIT). **No third-party runtime dependencies** are introduced.
- **Fonts / icons / images / audio / external code**: none (demo narration is original).

## License

MIT. See [LICENSE](LICENSE).

---

<p align="center">
  <sub>2026 Jiangsu AI+ Science & Engineering Innovation Hackathon · Undergraduate track · Team "一个人的AI" (One Person's AI) · Entry U098</sub>
</p>
