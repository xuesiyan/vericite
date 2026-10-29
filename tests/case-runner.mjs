/**
 * tests/case-runner.mjs — 测试样例加载与执行
 *
 * 该模块被 cli.mjs（演示/证据导出）与 tests/run.mjs（回归测试）共同引用，
 * 保证「演示所跑」与「测试所验」是同一条代码路径——
 * 避免出现演示专用分支这种在评审中最容易被质疑的做法。
 *
 * 样例文件结构（tests/cases/*.json）：
 * {
 *   case_id, category: normal|boundary|failure, title, focus,
 *   input_text,                                  // 待核查文本
 *   k,                                           // 可选：候选证据片段数
 *   corpus_fixture,                              // 可选：使用 tests/fixtures/<name>.json 作为语料
 *   model_verdicts: [{claim_id, verdict, reason}],// 可选：模拟 Agnes 模型通道的独立判定
 *   quotes: [{span_id, text}],                   // 可选：需额外校验真实性的引文
 *   expect: { decision, error_codes: [], min_claims, max_grounding_rate }
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Corpus, loadCorpus } from '../core/corpus.mjs';
import { auditDraft } from '../core/audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = path.join(__dirname, 'cases');
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const fixtureCache = new Map();

/** 加载某个夹具语料（供对抗性测试使用，与真实文献语料隔离） */
export function loadFixture(name) {
  if (fixtureCache.has(name)) return fixtureCache.get(name);
  const file = path.join(FIXTURES_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`语料夹具不存在：${file}`);
  const c = new Corpus(JSON.parse(fs.readFileSync(file, 'utf8')), { corpusPath: file });
  fixtureCache.set(name, c);
  return c;
}

export function loadCases({ category = null, only = null } = {}) {
  if (!fs.existsSync(CASES_DIR)) return [];
  const cases = fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8')) }))
    .sort((a, b) => String(a.case_id).localeCompare(String(b.case_id)));
  return cases.filter((c) => (!category || c.category === category) && (!only || c.case_id === only));
}

/**
 * 执行单个样例，返回结果与断言明细。
 * @param {object} caseObj
 * @param {Corpus} defaultCorpus 真实文献语料（样例未指定夹具时使用）
 */
export function runCase(caseObj, defaultCorpus) {
  const corpus = caseObj.corpus_fixture ? loadFixture(caseObj.corpus_fixture) : defaultCorpus;
  const result = auditDraft(caseObj.input_text, corpus, {
    k: caseObj.k || 8,
    modelVerdicts: caseObj.model_verdicts || [],
    quotes: caseObj.quotes || [],
  });

  const exp = caseObj.expect || {};
  const actualCodes = result.error_codes;

  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  if (exp.decision) {
    push('最终裁决', result.decision === exp.decision, `期望 ${exp.decision}，实际 ${result.decision}`);
  }
  for (const code of exp.error_codes || []) {
    push(`触发错误码 ${code}`, actualCodes.includes(code), actualCodes.includes(code) ? '已触发' : `实际错误码 [${actualCodes.join(', ')}]`);
  }
  for (const code of exp.absent_error_codes || []) {
    push(`不应触发 ${code}`, !actualCodes.includes(code), actualCodes.includes(code) ? '却触发了' : '未触发');
  }
  if (exp.min_claims !== undefined) {
    push('主张数下限', result.summary.atomic_claims >= exp.min_claims, `期望 ≥${exp.min_claims}，实际 ${result.summary.atomic_claims}`);
  }
  if (exp.min_supported !== undefined) {
    push('已验证主张数下限', result.summary.supported >= exp.min_supported, `期望 ≥${exp.min_supported}，实际 ${result.summary.supported}`);
  }
  if (exp.max_grounding_rate !== undefined) {
    push('依据覆盖率上限', result.summary.grounding_rate <= exp.max_grounding_rate, `期望 ≤${exp.max_grounding_rate}，实际 ${result.summary.grounding_rate}`);
  }
  if (exp.all_claims_grounded) {
    push('全部主张均有依据', result.summary.supported === result.summary.atomic_claims && result.summary.atomic_claims > 0,
      `${result.summary.supported}/${result.summary.atomic_claims}`);
  }
  if (exp.every_claim_has_citation) {
    const ok = result.summary.atomic_claims > 0 && result.output?.citations?.every((c) => c.citations.length > 0);
    push('每条结论均带引用', !!ok, ok ? '全部带 span 级引用' : '存在无引用结论');
  }

  return {
    case: caseObj,
    result,
    corpus_used: caseObj.corpus_fixture ? `fixture:${caseObj.corpus_fixture}` : 'corpus:vericite-corpus-v1',
    checks,
    pass: checks.every((c) => c.ok),
  };
}

export { loadCorpus };
