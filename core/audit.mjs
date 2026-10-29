/**
 * core/audit.mjs — 主张拆解、闭环编排与双通道仲裁
 *
 * ======================= 本文件承载系统的安全内核 =======================
 * 系统中存在两条相互独立的判定通道：
 *
 *   通道 A（确定性核验，core/verify.mjs）
 *     —— 纯算法，无随机性，同输入必得同输出，可复现、可审计。
 *
 *   通道 B（Agnes 模型判定）
 *     —— 由 AGH 的 agent loop 产生，具备语义理解优势，但存在随机性。
 *
 * 仲裁规则被刻意设计成**非对称**的：
 *
 *     模型通道可以让一条「看似合格」的主张被拦下（升级为人工复核），
 *     但模型通道**永远无法**让一条被确定性通道否决的主张通过。
 *
 * 这条规则的意义：把「是否放行」的最终否决权交给可复现的算法，
 * 使整个系统不会因为模型的一次自信幻觉而输出未经证实的结论。
 * 这正是「若无依据则直接拒绝输出」这一命题在工程上的落地方式。
 * ======================================================================
 */

import { splitSentences, normalizeWs } from './text.mjs';
import { verifyClaim, verifyQuote, detectInjection, THRESHOLDS } from './verify.mjs';
import { makeError, sortErrors } from './errors.mjs';

/* ------------------------- 引用标记处理 ------------------------- */

/** 去掉行内引用标记后再检索，避免 [12] / (Smith et al., 2021) 干扰词覆盖 */
export function stripCitationMarkers(s) {
  return String(s || '')
    .replace(/\[\s*\d+(?:\s*[-,–]\s*\d+)*\s*\]/g, ' ')
    .replace(/\(\s*[A-Z][A-Za-z.\-']+(?:\s+(?:et\s+al\.?|and|&)\s+[A-Z][A-Za-z.\-']*)*\s*,\s*(?:19|20)\d{2}[a-z]?\s*\)/g, ' ')
    .replace(/（\s*[^）]{0,40}?\d{4}\s*）\s*(?=[，。；]|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NON_CLAIM_PREFIXES = [
  '参考文献', '参考来源', '参考文献列表', 'references', 'bibliography',
  '如下所示', '总结如下', '综上',
];

/**
 * 判断一句话是否构成「可核查主张」。
 * 标题式短语、纯提问、元话语（如「本文分三部分」）不是主张，不进入核验。
 */
export function classifySentence(s) {
  const t = normalizeWs(s);
  if (t.length < 12) return { is_claim: false, reason: 'too_short' };
  const low = t.toLowerCase();
  if (NON_CLAIM_PREFIXES.some((p) => low.startsWith(p))) return { is_claim: false, reason: 'non_claim_section_label' };
  if (/[?？]$/.test(t)) return { is_claim: false, reason: 'question' };
  // 无句末标点的短标题
  if (!/[.。！!?？;；]$/.test(t) && t.length < 46) return { is_claim: false, reason: 'heading_like' };
  // 纯元话语
  if (/^(the|this)\s+(paper|article|study|work|section)\s+(is|presents|describes|introduces|consists)\b/i.test(t)) {
    return { is_claim: false, reason: 'meta_discourse' };
  }
  if (/^(本文|本研究|本节|本综述)(分为|介绍|描述|分为|结构|组织)/.test(t)) return { is_claim: false, reason: 'meta_discourse' };
  return { is_claim: true, reason: 'ok' };
}

/** 从句标记：出现即认为该句可能携带多个并列断言 */
const CLAUSE_MARKERS = /(；|;|\band\b(?=\s)|\bwhile\b|\bwhereas\b|\bhowever\b|，而|同时|此外|另外|并且|而且)/gi;

/**
 * 将一段待核查文本拆解为原子主张。
 * 过长的句子会被继续切分——因为「一句话里塞三个断言」恰恰是
 * 让逐句溯源失效的常见手法。
 */
export function splitClaims(text, { maxAtomicLen = 210 } = {}) {
  const claims = [];
  const notes = [];
  const sents = splitSentences(text, 0);

  for (const s of sents) {
    const cls = classifySentence(s.text);
    if (!cls.is_claim) {
      claims.push({
        id: null,
        text: s.text,
        start: s.start,
        end: s.end,
        is_claim: false,
        skip_reason: cls.reason,
      });
      continue;
    }

    const clauseCount = (s.text.match(CLAUSE_MARKERS) || []).length;
    const tooLong = s.text.length > maxAtomicLen || clauseCount >= 3;

    if (!tooLong) {
      claims.push({ text: s.text, start: s.start, end: s.end, is_claim: true, atomic: true, clause_count: clauseCount });
      continue;
    }

    // 二次切分：在并列标记处断开，保留精确偏移
    const parts = [];
    const re = /(；|;|，而|同时，|此外，|另外，|并且，|而且，|,\s+and\s+|,\s+while\s+|,\s+whereas\s+|,\s+however,\s+)/gi;
    let cursor = 0;
    let m;
    const cuts = [];
    while ((m = re.exec(s.text)) !== null) cuts.push(m.index + m[0].length);
    if (cuts.length === 0) cuts.push(s.text.length);
    const bounds = [0, ...cuts.filter((c) => c < s.text.length - 20), s.text.length];
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i];
      const b = bounds[i + 1];
      const raw = s.text.slice(a, b);
      const trimmed = raw.trim();
      if (trimmed.length < 12) continue;
      const lead = raw.length - raw.trimStart().length;
      parts.push({ text: trimmed, start: s.start + a + lead, end: s.start + a + lead + trimmed.length });
    }
    if (parts.length <= 1) {
      claims.push({ text: s.text, start: s.start, end: s.end, is_claim: true, atomic: true, clause_count: clauseCount });
      continue;
    }
    notes.push({ type: 'claim_split', original: s.text, parts: parts.map((p) => p.text) });
    parts.forEach((p) =>
      claims.push({ ...p, is_claim: true, atomic: true, clause_count: 1, split_from: s.text }),
    );
  }

  let n = 0;
  for (const c of claims) if (c.is_claim) c.id = `C${String(++n).padStart(3, '0')}`;
  return { claims, notes };
}

/* --------------------------- 双通道仲裁 --------------------------- */

const VERDICT_SEVERITY = { supported: 0, insufficient: 1, contradicted: 2 };

/**
 * 合并确定性通道与模型通道的判定。
 * @param {{claim_id:string, verdict:string, confidence?:number, reason?:string}[]} modelVerdicts
 */
export function adjudicate(claimRecords, modelVerdicts = []) {
  const byId = new Map(modelVerdicts.map((m) => [String(m.claim_id).toUpperCase(), m]));
  const out = [];
  for (const rec of claimRecords) {
    const mv = byId.get(rec.claim_id) || null;
    const dv = rec.verdict;
    let final = dv;
    const errors = [...rec.errors];
    let consensus = 'no_model_opinion';

    if (mv) {
      const mVer = String(mv.verdict || '').toLowerCase();
      const known = ['supported', 'insufficient', 'contradicted'];
      if (!known.includes(mVer)) {
        errors.push(makeError('E_MODEL_CONFLICT', { claim_id: rec.claim_id, note: `模型返回了非法判定：${mv.verdict}` }));
        consensus = 'invalid_model_output';
      } else if (mVer === dv) {
        consensus = 'agree';
      } else {
        consensus = 'disagree';
        makeErrorSafe(errors, 'E_MODEL_CONFLICT', {
          claim_id: rec.claim_id,
          deterministic_verdict: dv,
          model_verdict: mVer,
          model_reason: mv.reason || null,
          resolution:
            VERDICT_SEVERITY[mVer] < VERDICT_SEVERITY[dv]
              ? '模型认为可放行，但确定性通道已否决；按规则不放行，升级人工复核。'
              : '模型提出更严重的疑点，按从严原则采纳为需复核。',
        });
        // 非对称规则：确定性通道的否决不可被模型推翻
        final = VERDICT_SEVERITY[mVer] > VERDICT_SEVERITY[dv] ? mVer : dv;
      }
    }
    out.push({ ...rec, final_verdict: final, consensus, model_verdict: mv, errors: sortErrors(errors) });
  }
  return out;
}

function makeErrorSafe(arr, code, detail) {
  // 保证不重复堆叠同码错误
  const e = makeError(code, detail);
  if (!arr.some((x) => x.code === code && JSON.stringify(x.detail) === JSON.stringify(detail))) arr.push(e);
  return arr;
}

/* --------------------------- 闭环编排 --------------------------- */

/**
 * 对一段待核查文本执行完整闭环：
 *   规划（拆主张） → 工具调用（检索） → 结果验证（双通道） → 异常处理（拒绝/升级）
 *
 * @param {string} text 待核查文本（例如 AI 生成的文献总结）
 * @param {Corpus} corpus
 * @param {{k?:number, modelVerdicts?:Array, quotes?:Array, docFilter?:Function, onEvent?:Function}} opts
 */
export function auditDraft(text, corpus, opts = {}) {
  const {
    k = 8,
    modelVerdicts = [],
    quotes = [],
    docFilter = null,
    retrievalQueryFor = null,
    onEvent = null,
    preLedgerEvents = [],
  } = opts;

  const t0 = Date.now();
  const ledger = [];
  const emit = (ev) => {
    const rec = { ts: new Date().toISOString(), seq: ledger.length + 1, ...ev };
    ledger.push(rec);
    if (onEvent) onEvent(rec);
  };

  // 外部通道（如 Agnes 模型第二意见）的调用记录先行入账，保证账本完整可审计
  for (const ev of preLedgerEvents) emit(ev);

  const errors = [];

  emit({ stage: 'plan', action: 'audit_start', input_chars: text.length });
  emit({
    stage: 'plan', action: 'corpus_loaded',
    corpus_id: corpus.meta.corpus_id,
    doc_count: corpus.meta.doc_count,
    content_sha256: corpus.meta.content_sha256,
    span_count: corpus.spans.size,
  });

  // 语料边界声明：超出语料范围的问题必须显式拒绝，而不是靠模型记忆作答
  const { claims, notes } = splitClaims(text);
  const claimList = claims.filter((c) => c.is_claim);
  emit({ stage: 'plan', action: 'claim_decomposition', total_sentences: claims.length, atomic_claims: claimList.length, splits: notes.length });
  for (const n of notes) emit({ stage: 'plan', action: 'claim_split', detail: n });

  // 语言探测
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const dominant = cjk > latin ? 'zh' : 'en';
  if (!cjk && !latin) {
    errors.push(makeError('E_UNSUPPORTED_LANGUAGE', { cjk, latin }));
    emit({ stage: 'plan', action: 'language_warning', dominant: 'unknown' });
  } else {
    emit({ stage: 'plan', action: 'language_detected', dominant });
  }

  if (claimList.length === 0) {
    const err = makeError('E_EMPTY_QUERY', { reason: '待核查文本中未识别出可核查主张' });
    errors.push(err);
    emit({ stage: 'verify', action: 'abort', code: err.code });
    return buildResult({ text, corpus, claims, claimRecords: [], errors, ledger, t0, decision: 'REFUSE' });
  }

  // 工具调用 + 结果验证
  const claimRecords = [];
  for (const c of claimList) {
    const query = stripCitationMarkers(c.text) || c.text;
    const retrievalQuery = retrievalQueryFor ? retrievalQueryFor(c) : query;
    emit({ stage: 'tool_call', action: 'vericite_claim_search', claim_id: c.id, query: retrievalQuery });

    const r = verifyClaim(c.text, corpus, { k, docFilter, retrievalQuery });
    for (const ev of r.trace) emit({ stage: 'tool_result', claim_id: c.id, ...ev });

    claimRecords.push({
      claim_id: c.id,
      claim: c.text,
      char_range: [c.start, c.end],
      split_from: c.split_from || null,
      verdict: r.verdict,
      confidence: r.confidence,
      evidence_for_claim: r.evidence,
      primary_evidence: r.primary_evidence,
      errors: r.errors,
      metrics: r.metrics,
    });

    emit({
      stage: 'verify', action: 'claim_verified', claim_id: c.id,
      verdict: r.verdict, confidence: r.confidence,
      primary_span: r.primary_evidence?.span_id || null,
      error_codes: r.errors.map((e) => e.code),
    });
  }

  // 引文真实性抽检
  const quoteChecks = [];
  for (const q of quotes) {
    emit({ stage: 'tool_call', action: 'vericite_quote_check', span_id: q.span_id });
    const res = verifyQuote(q.span_id, q.text, corpus);
    quoteChecks.push({ span_id: q.span_id, quoted_text: q.text, ok: res.ok, similarity: res.similarity, errors: res.errors });
    if (!res.ok) errors.push(...res.errors);
    emit({ stage: 'verify', action: 'quote_checked', span_id: q.span_id, ok: res.ok, similarity: res.similarity });
  }

  // 双通道仲裁
  for (const rec of claimRecords) {
    for (const e of rec.errors) if (e.severity === 'fatal') errors.push(e);
  }

  const adjudicated = adjudicate(claimRecords, modelVerdicts);
  emit({
    stage: 'verify', action: 'dual_channel_adjudicated',
    model_opinions: modelVerdicts.length,
    agreements: adjudicated.filter((a) => a.consensus === 'agree').length,
    disagreements: adjudicated.filter((a) => a.consensus === 'disagree').length,
  });

  for (const a of adjudicated) {
    for (const e of a.errors) {
      if (e.severity === 'degrade' && !errors.some((x) => x.code === e.code && x.detail?.claim_id === e.detail?.claim_id)) {
        errors.push(e);
      }
    }
  }

  // 异常处理 → 最终裁决
  const fatal = errors.filter((e) => e.severity === 'fatal');
  const degrade = errors.filter((e) => e.severity === 'degrade');
  const unsupportedClaims = adjudicated.filter((a) => a.final_verdict !== 'supported');

  let decision;
  if (fatal.length > 0) decision = 'REFUSE';
  else if (degrade.length > 0) decision = 'ESCALATE';
  else decision = 'PASS';

  emit({ stage: 'exception', action: 'decision', decision, fatal: fatal.length, degrade: degrade.length, unsupported_claims: unsupportedClaims.length });

  return buildResult({ text, corpus, claims, claimRecords: adjudicated, quoteChecks, errors, ledger, t0, decision });
}

function buildResult({ text, corpus, claims, claimRecords, quoteChecks = [], errors, ledger, t0, decision }) {
  const unique = [];
  const seen = new Set();
  for (const e of sortErrors(errors)) {
    const key = `${e.code}:${JSON.stringify(e.detail || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }

  const supported = claimRecords.filter((r) => r.final_verdict === 'supported');
  const citationMap = claimRecords.map((r) => ({
    claim_id: r.claim_id,
    claim: r.claim,
    verdict: r.final_verdict,
    citations: (r.evidence_for_claim || [])
      .filter((e) => e.role === 'support' || (r.final_verdict === 'supported' && e.role !== 'counter_evidence'))
      .map((e) => ({ span_id: e.span_id, doc_id: e.doc_id, char_range: e.char_range })),
    counter_evidence: (r.evidence_for_claim || []).filter((e) => e.role === 'counter_evidence').map((e) => ({ span_id: e.span_id, char_range: e.char_range })),
  }));

  // 「输出」只有在 PASS 时才存在——这是本系统的对外契约
  const output = decision === 'PASS'
    ? {
        kind: 'verified_summary',
        text,
        citations: citationMap,
        note: '全部主张均已通过双通道核验，每条结论均可回溯到语料中的具体片段。',
      }
    : {
        kind: 'refusal',
        reason:
          decision === 'REFUSE'
            ? '存在无法用原文依据支撑的主张，系统拒绝输出结论。'
            : '存在需人工复核的判定分歧，系统不放行该结论。',
        blocking_errors: unique.filter((e) => e.severity !== 'warn').map((e) => ({ code: e.code, message: e.message, detail: e.detail })),
        unsupported_claims: claimRecords
          .filter((r) => r.final_verdict !== 'supported')
          .map((r) => ({ claim_id: r.claim_id, claim: r.claim, verdict: r.final_verdict, error_codes: r.errors.map((e) => e.code) })),
      };

  return {
    vericite_version: '1.0.0',
    decision,
    input_text: text,
    corpus: {
      corpus_id: corpus.meta.corpus_id,
      doc_count: corpus.meta.doc_count,
      span_count: corpus.spans.size,
      content_sha256: corpus.meta.content_sha256,
    },
    summary: {
      sentences: claims.length,
      atomic_claims: claimRecords.length,
      supported: supported.length,
      contradicted: claimRecords.filter((r) => r.final_verdict === 'contradicted').length,
      insufficient: claimRecords.filter((r) => r.final_verdict === 'insufficient').length,
      grounding_rate: claimRecords.length ? Number((supported.length / claimRecords.length).toFixed(4)) : 0,
      elapsed_ms: Date.now() - t0,
    },
    claims: claimRecords,
    non_claim_sentences: claims.filter((c) => !c.is_claim),
    quote_checks: quoteChecks,
    errors: unique,
    error_codes: [...new Set(unique.map((e) => e.code))],
    ledger,
    output,
    thresholds: THRESHOLDS,
  };
}
