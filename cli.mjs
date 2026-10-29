#!/usr/bin/env node
/**
 * cli.mjs — VeriCite 命令行入口
 *
 * 作用有三：
 *   1. 直接演示完整闭环（任务规划 → 工具调用 → 结果验证 → 异常处理）；
 *   2. 导出可复现、可审计的**运行证据**（JSON + JSONL 事件账本），供赛事人工核查；
 *   3. 作为 AGH 之外的等价执行路径——用来证明 AGH 内的行为不是"演示专用代码"。
 *
 * 用法：
 *   node cli.mjs corpus                          查看语料边界
 *   node cli.mjs search --query "..."            检索候选证据片段
 *   node cli.mjs span --id "<span_id>"           取回证据原文
 *   node cli.mjs audit --file sample.txt         核查一个文件
 *   node cli.mjs audit --text "..."               核查一段文本
 *   node cli.mjs demo --all                      跑全部内置样例并导出证据
 *   node cli.mjs demo --case normal              跑单个样例
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus } from './core/corpus.mjs';
import { verifyClaim, verifyQuote, THRESHOLDS } from './core/verify.mjs';
import { auditDraft, splitClaims, stripCitationMarkers } from './core/audit.mjs';
// 样例执行逻辑集中放在 tests/case-runner.mjs，由演示与回归测试共用同一条代码路径
import { loadCases as loadCaseFiles, runCase as runCaseFile } from './tests/case-runner.mjs';
import { ERROR_CODES } from './core/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, 'tests', 'cases');
const EVIDENCE_DIR = path.join(__dirname, 'evidence');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[36m', magenta: '\x1b[35m', gray: '\x1b[90m',
};
const paint = (c, s) => `${c}${s}${C.reset}`;

const VERDICT_STYLE = {
  supported: { c: C.green, marker: 'PASS  ' },
  insufficient: { c: C.yellow, marker: 'INSUFF' },
  contradicted: { c: C.red, marker: 'CONTRA' },
};
const DECISION_STYLE = { PASS: C.green, REFUSE: C.red, ESCALATE: C.yellow };

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

/* ------------------------------ 输出工具 ------------------------------ */

function hr(title = '') {
  const line = '─'.repeat(Math.max(4, 74 - title.length));
  return title ? `\n${paint(C.bold, title)} ${paint(C.gray, line)}` : paint(C.gray, '─'.repeat(78));
}

function truncate(s, n = 200) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/* ------------------------------ 命令实现 ------------------------------ */

function cmdCorpus() {
  const c = loadCorpus();
  const ov = c.overview();
  console.log(hr('语料库边界'));
  console.log(`  语料 ID      ${paint(C.blue, ov.corpus_id)}`);
  console.log(`  主题域       ${ov.domain}`);
  console.log(`  文献数       ${ov.doc_count}  （含全文 ${ov.fulltext_count} 篇）`);
  console.log(`  证据片段数   ${paint(C.bold, String(ov.span_count))}`);
  console.log(`  总字符数     ${ov.total_chars.toLocaleString()}`);
  console.log(`  语料指纹     ${paint(C.gray, ov.content_sha256)}`);
  console.log(`  词典规模     ${ov.vocabulary} 词`);
  console.log(hr('分布'));
  console.log('  学科类别: ' + Object.entries(ov.by_category).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  '));
  console.log('  年份    : ' + Object.entries(ov.by_year).sort().map(([k, v]) => `${k}×${v}`).join('  '));
  console.log(hr('文献清单'));
  for (const d of ov.docs) {
    const kind = d.text_kind === 'fulltext' ? paint(C.green, 'FULL') : paint(C.gray, 'ABS ');
    console.log(`  ${kind} ${paint(C.gray, d.doc_id.padEnd(22))} ${String(d.year ?? '----')}  ${d.span_count.toString().padStart(4)}片段  ${truncate(d.title, 58)}`);
  }
  console.log();
}

function cmdSearch(args) {
  const c = loadCorpus();
  const q = args.query || args._.slice(1).join(' ');
  if (!q) throw new Error('缺少 --query');
  const k = Number(args.k || 8);
  const res = c.search(q, { k });
  console.log(hr(`检索: ${q}`));
  if (res.hits.length === 0) {
    console.log(paint(C.yellow, `  无命中（reason=${res.reason}）→ 该问题超出语料覆盖范围，应走 E_NO_EVIDENCE 拒答路径`));
    return;
  }
  for (const h of res.hits) {
    console.log(`\n  ${paint(C.blue, h.span_id)}`);
    console.log(`  ${paint(C.gray, `bm25=${h.bm25}  词覆盖=${h.query_token_coverage}  章节=${h.section}  《${truncate(h.doc_title, 50)}》`)}`);
    console.log(`  ${truncate(h.text, 320)}`);
  }
  console.log();
}

function cmdSpan(args) {
  const c = loadCorpus();
  const id = args.id || args._[1];
  if (!id) throw new Error('缺少 --id');
  const s = c.fetchSpan(id);
  console.log(hr('证据片段原文'));
  console.log(`  span_id      ${paint(C.blue, s.span_id)}`);
  console.log(`  文献         ${s.doc_title} (${s.year})  [${s.doc_meta.text_kind}]`);
  console.log(`  章节         ${s.section}`);
  console.log(`  字符区间     [${s.start}, ${s.end})  绝对偏移，可直接在原文中定位`);
  console.log(`  来源         ${s.doc_meta.abs_url}`);
  console.log(`  偏移一致性   ${s.verbatim === s.text ? paint(C.green, 'verbatim === text  ✓') : paint(C.red, '不一致 ✗')}`);
  console.log(hr('上文'));
  console.log('  ' + paint(C.gray, truncate(s.context_before, 240)));
  console.log(hr('本片段（引用对象）'));
  console.log('  ' + paint(C.bold, s.text));
  console.log(hr('下文'));
  console.log('  ' + paint(C.gray, truncate(s.context_after, 240)));
  console.log();
}

async function cmdAudit(args) {
  const c = loadCorpus();
  let text = args.text;
  if (!text && args.file) text = fs.readFileSync(path.resolve(args.file), 'utf8');
  if (!text) throw new Error('缺少 --text 或 --file');
  const k = Number(args.k || 8);

  let r;
  if (args.model) {
    // --model：启用 Agnes 网关「第二意见」通道（凭据读环境变量 AGNES_API_KEY，勿写入任何文件）
    const { auditWithModelChannel } = await import('./core/model-channel.mjs');
    r = await auditWithModelChannel(text, c, { k, model: args.model !== true ? args.model : undefined });
  } else {
    let modelVerdicts = [];
    if (args['model-verdicts']) {
      modelVerdicts = JSON.parse(fs.readFileSync(path.resolve(args['model-verdicts']), 'utf8'));
    }
    r = auditDraft(text, c, { k, modelVerdicts });
  }

  printAudit(r);
  if (args.save) {
    const out = path.resolve(args.save);
    fs.writeFileSync(out, JSON.stringify(r, null, 2), 'utf8');
    console.log(paint(C.gray, `  结果已保存 → ${out}`));
  }
  return r;
}

function printAudit(r) {
  const ds = DECISION_STYLE[r.decision] || C.reset;
  console.log(hr('闭环审计结果'));
  console.log(`  最终裁决     ${paint(C.bold + ds, r.decision)}`);
  console.log(`  语料         ${r.corpus.corpus_id}  (${r.corpus.doc_count} 篇 / ${r.corpus.span_count} 片段)`);
  console.log(
    `  主张统计     ${r.summary.atomic_claims} 条  →  ` +
      `${paint(C.green, r.summary.supported + ' 已证实')}  ` +
      `${paint(C.yellow, r.summary.insufficient + ' 依据不足')}  ` +
      `${paint(C.red, r.summary.contradicted + ' 与原文矛盾')}  ` +
      `| 依据覆盖率 ${(r.summary.grounding_rate * 100).toFixed(1)}%`,
  );
  console.log(`  耗时         ${r.summary.elapsed_ms} ms`);
  if (r.model_channel?.enabled) {
    const mc = r.model_channel;
    const line = mc.error
      ? `模型通道     ${paint(C.yellow, `未生效（${mc.error.code}）→ 已按纯确定性通道裁决`)}`
      : `模型通道     ${paint(C.magenta, mc.model)}  ${mc.latency_ms}ms  tokens ${mc.prompt_tokens ?? '?'}/${mc.completion_tokens ?? '?'}  意见 ${mc.verdict_count}/${mc.requested_claims}`;
    console.log(`  ${line}`);
  }
  if (r.error_codes.length) {
    console.log(`  错误码       ${r.error_codes.map((e) => paint(C.red, e)).join('  ')}`);
  }

  console.log(hr('逐条主张核验'));
  for (const cl of r.claims) {
    const st = VERDICT_STYLE[cl.final_verdict] || { c: C.reset, marker: '??????' };
    console.log(`\n  ${paint(C.bold, cl.claim_id)} ${paint(st.c, `[${st.marker}]`)} ${paint(C.gray, `置信 ${cl.confidence}`)}${cl.consensus && cl.consensus !== 'no_model_opinion' ? paint(C.magenta, `  ⟨模型通道:${cl.consensus}⟩`) : ''}`);
    console.log(`  ${cl.claim}`);
    if (cl.primary_evidence) {
      console.log(`  ${paint(C.gray, '└ 依据 ')}${paint(C.blue, cl.primary_evidence.span_id)}`);
      console.log(`    ${paint(C.gray, truncate(cl.primary_evidence.text, 210))}`);
    }
    if (cl.metrics?.coverage !== undefined) {
      console.log(`    ${paint(C.gray, `覆盖率=${cl.metrics.coverage}  数值一致=${cl.metrics.numeric_score}  bm25命中=${cl.metrics.retrieval?.hits}`)}`);
    }
    for (const e of cl.errors.filter((x) => x.severity !== 'warn')) {
      console.log(`    ${paint(C.red, '✗ ' + e.code)} ${paint(C.gray, truncate(e.message, 150))}`);
      if (e.detail?.evidence_text && e.code !== 'E_NO_EVIDENCE') {
        console.log(`      ${paint(C.gray, '反证原文: ' + truncate(e.detail.evidence_text, 170))}`);
      }
    }
  }

  console.log(hr('对外输出契约'));
  if (r.output.kind === 'verified_summary') {
    console.log(paint(C.green, '  ✓ 全部主张通过双通道核验，输出已获授权，逐条附带 span 级引用。'));
  } else {
    console.log(paint(C.red, `  ✗ ${r.output.reason}`));
    for (const e of r.output.blocking_errors) {
      console.log(`    ${paint(C.red, e.code)}  ${paint(C.gray, truncate(e.message, 140))}`);
    }
    console.log(paint(C.dim, '  说明：系统在任何一条主张缺乏原文依据时，都会拒绝输出而非降级为模糊表述。'));
  }
  console.log();
}

/* ------------------------------ 样例驱动 ------------------------------ */

function cmdDemo(args) {
  const c = loadCorpus();
  const only = loadCaseFiles({ only: args.case || null });
  if (only.length === 0) throw new Error('没有可运行的样例');

  const runs = [];
  console.log(hr(`VeriCite 闭环演示  ·  共 ${only.length} 个样例`));
  console.log(paint(C.gray, `  语料 ${c.meta.corpus_id}  文档 ${c.meta.doc_count}  候选片段 ${c.spans.size}  指纹 ${c.meta.content_sha256.slice(0, 16)}…\n`));

  for (const caseObj of only) {
    const tag = { normal: paint(C.green, '正常'), boundary: paint(C.yellow, '边界'), failure: paint(C.red, '失败') }[caseObj.category] || caseObj.category;
    console.log(hr(`[${tag}] ${caseObj.case_id} · ${caseObj.title}`));
    console.log(paint(C.gray, `  考察点: ${caseObj.focus}`));
    const r = runCaseFile(caseObj, c);
    printAudit(r.result);

    const exp = caseObj.expect || {};
    const head = r.pass ? paint(C.green, '样例通过 ✓') : paint(C.red, '样例未通过 ✗');
    console.log(`  ${head}  ${paint(C.gray, `期望裁决=${exp.decision}，实际=${r.result.decision}；期望错误码=[${(exp.error_codes || []).join(', ')}]，实际=[${r.result.error_codes.join(', ')}]`)}`);
    console.log(paint(C.gray, `  语料来源: ${r.corpus_used}`));
    for (const ck of r.checks) {
      console.log(`    ${ck.ok ? paint(C.green, '·') : paint(C.red, '×')} ${ck.name}  ${paint(C.gray, ck.detail)}`);
    }
    console.log();
    runs.push(r);
  }

  // 汇总
  const total = runs.length;
  const passed = runs.filter((r) => r.pass).length;
  const totalChecks = runs.reduce((s, r) => s + r.checks.length, 0);
  const passedChecks = runs.reduce((s, r) => s + r.checks.filter((c) => c.ok).length, 0);
  console.log(hr('汇总'));
  console.log(`  样例通过     ${passed}/${total}`);
  console.log(`  断言通过     ${passedChecks}/${totalChecks}`);
  const byDecision = {};
  for (const r of runs) byDecision[r.result.decision] = (byDecision[r.result.decision] || 0) + 1;
  console.log(`  裁决分布     ${Object.entries(byDecision).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  const allCodes = [...new Set(runs.flatMap((r) => r.result.error_codes))];
  console.log(`  覆盖错误码   ${allCodes.length} 类: ${allCodes.join(', ')}`);
  console.log();

  writeEvidence(runs, c);
}

/* ------------------------------ 证据导出 ------------------------------ */

function writeEvidence(runs, corpus) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // 1) 完整运行证据（机器可读）
  const payload = {
    vericite_version: '1.0.0',
    generated_at: new Date().toISOString(),
    generator: 'node cli.mjs demo --all',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    corpus: { corpus_id: corpus.meta.corpus_id, doc_count: corpus.meta.doc_count, span_count: corpus.spans.size, content_sha256: corpus.meta.content_sha256 },
    thresholds: THRESHOLDS,
    error_catalog: Object.fromEntries(Object.entries(ERROR_CODES).map(([k, v]) => [k, { severity: v.severity, stage: v.stage, handling: v.handling }])),
    summary: {
      total: runs.length,
      passed: runs.filter((r) => r.pass).length,
      assertions_passed: runs.reduce((s, r) => s + r.checks.filter((c) => c.ok).length, 0),
      assertions_total: runs.reduce((s, r) => s + r.checks.length, 0),
      decisions: runs.reduce((a, r) => ((a[r.result.decision] = (a[r.result.decision] || 0) + 1), a), {}),
      error_codes_covered: [...new Set(runs.flatMap((r) => r.result.error_codes))],
    },
    runs: runs.map((r) => ({
      case_id: r.case.case_id,
      category: r.case.category,
      title: r.case.title,
      focus: r.case.focus,
      expected: r.case.expect,
      passed: r.pass,
      corpus_used: r.corpus_used,
      checks: r.checks,
      decision: r.result.decision,
      summary: r.result.summary,
      error_codes: r.result.error_codes,
      errors: r.result.errors,
      claims: r.result.claims.map((cl) => ({
        claim_id: cl.claim_id,
        claim: cl.claim,
        final_verdict: cl.final_verdict,
        consensus: cl.consensus,
        confidence: cl.confidence,
        primary_span_id: cl.primary_evidence?.span_id ?? null,
        evidence: cl.evidence_for_claim,
        metrics: cl.metrics,
        error_codes: cl.errors.map((e) => e.code),
      })),
      quote_checks: r.result.quote_checks,
      output: r.result.output,
    })),
  };
  const p1 = path.join(EVIDENCE_DIR, 'run-latest.json');
  fs.writeFileSync(p1, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(path.join(EVIDENCE_DIR, `run-${stamp}.json`), JSON.stringify(payload, null, 2), 'utf8');

  // 2) 事件账本（JSONL）：逐步记录，等价于 AGH 的 execution records
  const lines = [];
  for (const r of runs) {
    for (const ev of r.result.ledger) {
      lines.push(JSON.stringify({ case_id: r.case.case_id, ...ev }));
    }
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf8');

  // 3) 工具调用链（赛事要求「≥1 条工具/设备调用链」）
  const chains = runs.map((r) => ({
    case_id: r.case.case_id,
    chain: r.result.ledger
      .filter((e) => ['tool_call', 'tool_result', 'verify', 'exception'].includes(e.stage))
      .map((e) => `${e.stage}:${e.action}${e.claim_id ? `@${e.claim_id}` : ''}${e.span_id ? `(${e.span_id})` : ''}${e.error_codes ? ` -> ${e.error_codes.join('|')}` : ''}${e.code ? ` -> ${e.code}` : ''}`),
  }));
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'tool-call-chains.json'), JSON.stringify(chains, null, 2), 'utf8');

  // 4) 人的可读摘要
  const md = [
    '# VeriCite 运行证据摘要',
    '',
    `- 生成时间：${payload.generated_at}`,
    `- 运行环境：Node ${payload.runtime.node} / ${payload.runtime.platform}-${payload.runtime.arch}`,
    `- 语料：${payload.corpus.corpus_id}（${payload.corpus.doc_count} 篇文献，${payload.corpus.span_count} 个证据片段）`,
    `- 语料指纹 SHA-256：\`${payload.corpus.content_sha256}\``,
    `- 复现命令：\`node cli.mjs demo --all\``,
    '- 核验通道：确定性算法（非 LLM-as-a-judge），同输入必得同输出',
    '',
    '## 样例结果',
    '',
    '| 样例 | 类别 | 考察点 | 期望裁决 | 实际裁决 | 触发错误码 | 通过 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...runs.map((r) =>
      `| ${r.case.case_id} | ${r.case.category} | ${r.case.focus} | ${r.case.expect?.decision ?? '-'} | ${r.result.decision} | ${r.result.error_codes.join('<br>') || '-'} | ${r.pass ? '✅' : '❌'} |`,
    ),
    '',
    '## 统计',
    '',
    `- 样例通过：${payload.summary.passed}/${payload.summary.total}`,
    `- 裁决分布：${Object.entries(payload.summary.decisions).map(([k, v]) => `${k}=${v}`).join('，')}`,
    `- 覆盖错误码：${payload.summary.error_codes_covered.join('、')}`,
    '',
    '## 产物清单',
    '',
    '- `evidence/run-latest.json` — 完整运行证据（逐条主张、证据、指标、错误详情）',
    '- `evidence/ledger.jsonl` — 逐步事件账本（对应 AGH execution records）',
    '- `evidence/tool-call-chains.json` — 工具调用链',
    '- `evidence/summary.md` — 本文件',
    '- `evidence/agh-integration.json` / `.md` — AGH 插件装载与工具链执行证据',
    '  （由 `node tools/run-agh-integration.mjs` 生成，独立于本文件）',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'summary.md'), md, 'utf8');

  console.log(hr('运行证据已导出'));
  console.log('  evidence/run-latest.json        完整运行证据');
  console.log('  evidence/ledger.jsonl           逐步事件账本');
  console.log('  evidence/tool-call-chains.json  工具调用链');
  console.log('  evidence/summary.md             可读摘要');
  console.log();
}

/* ------------------------------ main ------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'corpus': return cmdCorpus();
    case 'search': return cmdSearch({ ...args, _: argv.slice(1) });
    case 'span': return cmdSpan({ ...args, _: argv.slice(1) });
    case 'audit': return void cmdAudit(args).catch((e) => {
      console.error(`audit 失败：${e.message}`);
      process.exitCode = 1;
    });
    case 'demo': return cmdDemo(args);
    case 'help':
    case undefined:
      console.log(`
VeriCite — 科研文献溯源核查智能体

  node cli.mjs corpus                    查看语料边界
  node cli.mjs search --query "关键词"    检索候选证据片段
  node cli.mjs span --id <span_id>       取回证据原文（含回溯校验）
  node cli.mjs audit --text "..."        核查一段文本
  node cli.mjs audit --file path.txt     核查一个文件
  node cli.mjs audit --text "..." --model [--save out.json]
                                         启用 Agnes 模型第二意见通道（需环境变量 AGNES_API_KEY）
  node cli.mjs demo --all                跑全部内置样例并导出运行证据
  node cli.mjs demo --case normal-01     跑单个样例
`);
      return;
    default:
      console.error(`未知命令：${cmd}`);
      process.exitCode = 2;
  }
}

main();
