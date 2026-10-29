/**
 * core/verify.mjs — 溯源核验引擎（确定性通道）
 *
 * ============================ 设计立场 ============================
 * 市面上多数「幻觉检测」方案的做法是：再叫一个大模型来判断前一个大模型
 * 说得对不对（LLM-as-a-judge）。这条路在本项目里被**有意放弃**，原因有二：
 *   1. 不可复现——同一输入不同次运行可能给出不同判定，无法作为验证证据；
 *   2. 循环论证——判官模型与被判模型共享同一套先验，恰恰是最容易一起幻觉的地方。
 *
 * 因此本引擎的核验通道是**确定性算法**：
 *   给定（主张, 证据集合）→ 永远得到同一个判定，且每一步扣分理由都能打印出来。
 *   模型通道（由 AGH 的 agent loop 提供）作为**第二意见**并行存在，
 *   二者不一致时不放行、不否决，而是升级为「需人工复核」——
 *   模型永远无法单方面覆盖确定性通道的否决（见 core/audit.mjs 的仲裁规则）。
 * =================================================================
 *
 * ======================= 三条判定原则 =======================
 * 本文件里最容易被做错的三个地方，这里显式声明其处理原则：
 *
 *  P1「覆盖率是概念级的，不是词级的」
 *     一个中文术语对应一组英文等价表述，命中任一即算该概念被覆盖；
 *     否则同义词展开会稀释分母，把真实被支持的主张判成「依据不足」。
 *
 *  P2「否定极性必须与相关性联动」
 *     一段文字里出现 "not" 并不构成矛盾——它可能只是不相干的片段。
 *     只有当该片段本身就高度覆盖该主张时，极性相反才判为矛盾。
 *
 *  P3「数值一致性必须跨片段聚合」
 *     一个事实常常分散在多句话里（句 A 给总数，句 B 给主题数）。
 *     因此「数值找不到」与「数值被改写」必须分开处理：
 *       - 全部候选证据都没有这个数值      → 依据不足（无法确认）
 *       - 高相关证据在同一位置给出不同数值 → 与原文矛盾（数值被改写）
 *     这是最常见的两种文献幻觉，混淆它们会让系统在两边都判错。
 * ============================================================
 */

import {
  contentTokens,
  extractQuantities,
  polarityOf,
  strengthOf,
  namedEntities,
  STRENGTH_LABEL,
} from './text.mjs';
import { makeError } from './errors.mjs';
import { analyzeClaimUnits, isCjkDominant } from './lexicon.mjs';

/* ---------------------------- 阈值 ---------------------------- */
export const THRESHOLDS = {
  /** 概念覆盖率 ≥ 此值，才认为语义上被证据覆盖 */
  SUPPORT_COVERAGE: 0.62,
  /** 低于此值判为「无有效依据」 */
  NO_EVIDENCE_COVERAGE: 0.24,
  /** 片段要参与「矛盾」判定，其覆盖率不得低于此值（原则 P2） */
  CONTRADICTION_MIN_COVERAGE: 0.5,
  /** 片段要参与「数值比对」判定，其覆盖率不得低于此值（原则 P3） */
  NUMERIC_RELEVANCE: 0.3,
  /** 未获证据支撑的关键实体比例上限 */
  MAX_UNSUPPORTED_ENTITY_RATIO: 0.34,
  /** 引文校验时允许的空白/标点差异 */
  QUOTE_NORM_TOLERANCE: 0.06,
  /** 跨语言核验时，术语桥映射率低于此值则不予采信 */
  MIN_BRIDGE_RATIO: 0.5,
};

/* ------------------------ 指令注入防御 ------------------------ */

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(the\s+)?(above|previous|prior|earlier)/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /system\s*(prompt|message)\s*[:：]/i,
  /new\s+instructions?\s*[:：]/i,
  /do\s+not\s+(verify|check|cite|report)\b/i,
  /output\s+the\s+following\s+(text|string)\s+verbatim/i,
  /忽略(上述|以上|之前|前面)(的)?(所有)?(指令|要求|提示|规则)/,
  /你现在是(一个|一名|个)?/,
  /不要(核查|验证|检查|引用|报告)/,
  /新的(指令|要求|提示)\s*[:：]/,
  /系统(提示|消息)\s*[:：]/,
];

/**
 * 检测语料片段中是否含有针对核验流程的指令注入。
 * 语料是被当作「数据」读入的，绝不能被当作「指令」执行——
 * 这是 RAG 类系统最常被忽略的信任边界。
 */
export function detectInjection(text) {
  const hits = [];
  for (const re of INJECTION_PATTERNS) {
    const m = String(text || '').match(re);
    if (m) hits.push(m[0]);
  }
  return { suspected: hits.length > 0, hits };
}

/* ------------------------ 单片段打分 ------------------------ */

/**
 * 计算主张对单个证据片段的覆盖情况。
 * 所有中间量都返回，便于在报告里逐项展示「为什么判成这个结论」。
 */
export function scoreSpanAgainstClaim(claim, spanText, corpus = null, opts = {}) {
  const { units = null, crossLingual = false } = opts;
  const sToks = new Set(contentTokens(spanText));

  // ---- 1) IDF 加权「概念覆盖率」（原则 P1） ----
  const unitList =
    units && units.length
      ? units
      : contentTokens(claim).map((t) => ({ key: t, kind: 'token', alts: [t] }));
  let num = 0;
  let den = 0;
  const matched = [];
  const unmatched = [];
  for (const u of unitList) {
    let w = 0;
    for (const a of u.alts) {
      const cand = corpus ? corpus.idf(a) : Math.log(2 + String(a).length);
      if (cand > w) w = cand;
    }
    if (!(w > 0)) w = Math.log(2 + String(u.key).length) * 0.5;
    den += w;
    const hit = u.alts.some((a) => sToks.has(a));
    if (hit) {
      num += w;
      matched.push(u.key);
    } else {
      unmatched.push(u.key);
    }
  }
  const coverage = den > 0 ? num / den : 0;

  // ---- 2) 数量一致性（逐片段明细，聚合在 verifyClaim 中完成，原则 P3） ----
  const cQ = extractQuantities(claim);
  const sQ = extractQuantities(spanText);
  const numericChecks = cQ.map((q) => ({
    claim_quantity: q,
    exact_match: sQ.some((r) => r.value === q.value && (r.unit === q.unit || !q.unit || !r.unit)),
    unit_mismatch: sQ.some((r) => r.value === q.value && r.unit !== q.unit && q.unit && r.unit),
  }));

  // ---- 3) 极性（逐片段明细；是否构成矛盾交由聚合阶段裁决，原则 P2） ----
  const cP = polarityOf(claim);
  const sP = polarityOf(spanText);
  const polarityDiffers = cP.negated !== sP.negated && (cP.count > 0 || sP.count > 0);

  // ---- 4) 主张强度越权 ----
  const cS = strengthOf(claim);
  const sS = strengthOf(spanText);
  const strengthOverclaim = cS.level === 2 && sS.level === 0;

  // ---- 5) 关键实体覆盖 ----
  const cE = namedEntities(claim);
  const unbackedEntities = cE.filter((e) => {
    const low = e.toLowerCase();
    if (String(spanText).toLowerCase().includes(low)) return false;
    const head = low.split(/\s+/)[0];
    return !(head.length > 3 && String(spanText).toLowerCase().includes(head));
  });
  const entityRatio = cE.length === 0 ? 0 : unbackedEntities.length / cE.length;

  return {
    coverage: Number(coverage.toFixed(4)),
    cross_lingual: crossLingual,
    matched_token_count: matched.length,
    claim_token_count: unitList.length,
    matched_concepts: matched.slice(0, 40),
    unmatched_tokens: [...new Set(unmatched)].slice(0, 24),
    numeric_checks: numericChecks,
    span_quantities: sQ,
    polarity: { claim: cP, evidence: sP, differs: polarityDiffers, conflict: polarityDiffers },
    strength: {
      claim: { level: cS.level, label: STRENGTH_LABEL[cS.level], hits: cS.hits },
      evidence: { level: sS.level, label: STRENGTH_LABEL[sS.level], hits: sS.hits },
      overclaim: strengthOverclaim,
    },
    entities: { claim: cE, unbacked: unbackedEntities, unsupported_ratio: Number(entityRatio.toFixed(4)) },
  };
}

/* ------------------------ 主张级核验 ------------------------ */

/**
 * 对一条主张执行完整核验：
 *   检索候选证据 → 逐片段打分 → 跨片段聚合 → 主张级判定 + 结构化错误
 */
export function verifyClaim(claim, corpus, { k = 8, docFilter = null, retrievalQuery = null } = {}) {
  const errors = [];
  const trace = [];
  const query = retrievalQuery || claim;

  // 中文主张检索前先做术语桥接：让中文问题能命中英文文献
  const analysis = analyzeClaimUnits(query);
  const bridgedQuery = isCjkDominant(query) ? analysis.bridged_query : query;

  let search;
  try {
    search = corpus.search(bridgedQuery, { k, docFilter });
  } catch (e) {
    const err = makeError(e.code || 'E_EMPTY_QUERY', { query }, e.message);
    return finish(claim, 'insufficient', 0, [], null, [err], { retrieval: { query: bridgedQuery, hits: 0 } }, trace);
  }
  trace.push({
    step: 'retrieve', query: bridgedQuery, hits: search.hits.length,
    reason: search.reason, original_query: query, bridged: bridgedQuery !== query,
  });

  if (search.hits.length === 0) {
    return finish(claim, 'insufficient', 0, [], null,
      [makeError('E_NO_EVIDENCE', { query, retrieval_query: bridgedQuery })],
      { retrieval: { query: bridgedQuery, hits: 0 } }, trace);
  }

  const scored = [];
  let quarantined = 0;
  for (const h of search.hits) {
    // 语料片段一律按「数据」对待：先做注入检测，命中即隔离
    const inj = detectInjection(h.text);
    if (inj.suspected) {
      quarantined += 1;
      errors.push(makeError('E_INJECTION_SUSPECTED', { span_id: h.span_id, patterns: inj.hits }));
      trace.push({ step: 'injection_guard', span_id: h.span_id, quarantined: true, patterns: inj.hits });
      continue;
    }
    const full = corpus.fetchSpan(h.span_id);
    // 引文真实性：span_id 编码的字符区间必须真的对应这段文字
    if (full.verbatim !== full.text) {
      errors.push(makeError('E_QUOTE_MISMATCH', { span_id: h.span_id, reason: 'span 偏移与文本不一致' }));
    }
    const score = scoreSpanAgainstClaim(claim, full.text, corpus, {
      units: analysis.units,
      crossLingual: analysis.cross_lingual,
    });
    score.bridge_ratio = analysis.bridge_ratio;
    score.mapped_terms = analysis.mapped_terms;
    score.unmapped_zh = analysis.unmapped_zh;
    scored.push({ ...h, span: full, score, bilingual: analysis });
    trace.push({
      step: 'score_span', span_id: h.span_id,
      coverage: score.coverage,
      polarity_differs: score.polarity.differs, overclaim: score.strength.overclaim,
      cross_lingual: analysis.cross_lingual, bridge_ratio: analysis.bridge_ratio,
    });
  }

  if (scored.length === 0) {
    return finish(claim, 'insufficient', 0, [], null,
      [...errors, makeError('E_NO_EVIDENCE', { query, note: '全部候选片段被注入防护隔离' })],
      { retrieval: { query: bridgedQuery, hits: search.hits.length } }, trace);
  }

  scored.sort((a, b2) => b2.score.coverage - a.score.coverage);
  const best = scored[0];
  const relevant = scored.filter((s) => s.score.coverage >= THRESHOLDS.NUMERIC_RELEVANCE);

  /* ---------------- 跨片段聚合 ---------------- */

  // A) 极性矛盾：仅当「高度相关」的片段极性相反（原则 P2）
  const polarityConflicts = scored.filter(
    (s) => s.score.polarity.differs && s.score.coverage >= THRESHOLDS.CONTRADICTION_MIN_COVERAGE,
  );

  // B) 数值：把全部「相关候选证据」合并为观测域（原则 P3）
  const claimQ = extractQuantities(claim);
  const observed = new Set();
  for (const s of relevant) for (const q of s.score.span_quantities) {
    observed.add(`${q.value}|${q.unit}`);
    observed.add(`${q.value}|`);
  }
  const unsatisfiedQ = claimQ.filter((q) => !observed.has(`${q.value}|${q.unit}`) && !observed.has(`${q.value}|`));

  // 「被改写」：高相关片段给出了与主张同样多的数值，却至少有一位不同 → 位置替换
  let numericSubstitution = null;
  if (unsatisfiedQ.length > 0 && claimQ.length > 0) {
    for (const s of scored) {
      if (s.score.coverage < THRESHOLDS.CONTRADICTION_MIN_COVERAGE) continue;
      const sq = s.score.span_quantities;
      if (sq.length !== claimQ.length) continue;
      const diffs = claimQ.map((q, i) => ({ claim: q, evidence: sq[i], same: sq[i].value === q.value }));
      if (diffs.some((d) => !d.same)) {
        numericSubstitution = { span: s, diffs };
        break;
      }
    }
  }

  // C) 强度越权
  const overclaimSpan = scored.find(
    (s) => s.score.strength.overclaim && s.score.coverage >= THRESHOLDS.NUMERIC_RELEVANCE,
  );

  // D) 实体未获支撑
  //    门槛刻意设高：只有当该片段在其余概念上高度吻合、唯独关键实体对不上时，
  //    才判定为「张冠李戴」。若覆盖率本来就低，那只是「依据不足」，
  //    强行归因为实体错配会把一个信息量不足的问题误报成事实性错误。
  const entityMismatch =
    best.score.entities.unsupported_ratio > THRESHOLDS.MAX_UNSUPPORTED_ENTITY_RATIO &&
    best.score.coverage >= THRESHOLDS.SUPPORT_COVERAGE * 0.85;

  // E) 跨语言映射不足
  const lowMapping = analysis.cross_lingual && analysis.bridge_ratio < THRESHOLDS.MIN_BRIDGE_RATIO;

  /* ---------------- 裁决（顺序即优先级） ---------------- */

  let verdict;
  let confidence;
  let bestSpan = best.span;

  if (polarityConflicts.length > 0) {
    verdict = 'contradicted';
    const c = polarityConflicts[0];
    bestSpan = c.span;
    confidence = Math.min(0.95, 0.55 + c.score.coverage * 0.4);
    errors.push(makeError('E_POLARITY_CONFLICT', {
      span_id: c.span.span_id,
      claim_polarity: c.score.polarity.claim.negated ? 'negated' : 'affirmed',
      evidence_polarity: c.score.polarity.evidence.negated ? 'negated' : 'affirmed',
      claim_negation_cues: c.score.polarity.claim.hits,
      evidence_negation_cues: c.score.polarity.evidence.hits,
      coverage: c.score.coverage,
      evidence_text: c.span.text,
    }));
  } else if (numericSubstitution) {
    verdict = 'contradicted';
    bestSpan = numericSubstitution.span.span;
    confidence = 0.92;
    errors.push(makeError('E_UNSUPPORTED_NUMERIC', {
      span_id: bestSpan.span_id,
      mode: 'value_substituted',
      diffs: numericSubstitution.diffs.map((d) => ({ claim: d.claim.raw, evidence: d.evidence.raw, same: d.same })),
      claim_quantities: claimQ.map((q) => q.raw),
      evidence_quantities: numericSubstitution.span.score.span_quantities.map((q) => q.raw),
      evidence_text: bestSpan.text,
    }));
  } else if (unsatisfiedQ.length > 0) {
    verdict = 'insufficient';
    confidence = Number(Math.min(0.5, best.score.coverage).toFixed(4));
    errors.push(makeError('E_UNSUPPORTED_NUMERIC', {
      span_id: best.span.span_id,
      mode: 'not_present_in_any_candidate',
      claim_quantities: claimQ.map((q) => q.raw),
      unsatisfied: unsatisfiedQ.map((q) => q.raw),
      searched_spans: relevant.length,
      evidence_text: best.span.text,
    }));
  } else if (overclaimSpan) {
    verdict = 'insufficient';
    confidence = Number(Math.min(0.6, overclaimSpan.score.coverage).toFixed(4));
    bestSpan = overclaimSpan.span;
    errors.push(makeError('E_STRENGTH_OVERCLAIM', {
      span_id: overclaimSpan.span.span_id,
      claim_strength: overclaimSpan.score.strength.claim.label,
      evidence_strength: overclaimSpan.score.strength.evidence.label,
      claim_cues: overclaimSpan.score.strength.claim.hits.strong,
      evidence_cues: overclaimSpan.score.strength.evidence.hits.hedge,
      evidence_text: overclaimSpan.span.text,
      suggestion: '将断言性表述降级为与证据一致的推测性表述后重试。',
    }));
  } else if (entityMismatch) {
    verdict = 'insufficient';
    confidence = Number((best.score.coverage * 0.6).toFixed(4));
    errors.push(makeError('E_ENTITY_MISMATCH', {
      span_id: best.span.span_id,
      unbacked_entities: best.score.entities.unbacked,
      coverage: best.score.coverage,
      evidence_text: best.span.text,
    }));
  } else if (lowMapping) {
    verdict = 'insufficient';
    confidence = Number((best.score.coverage * 0.6).toFixed(4));
    errors.push(makeError('E_CROSSLINGUAL_LOW_MAPPING', {
      span_id: best.span.span_id,
      bridge_ratio: analysis.bridge_ratio,
      unmapped_zh: analysis.unmapped_zh,
      mapped_terms: analysis.mapped_terms,
      threshold: THRESHOLDS.MIN_BRIDGE_RATIO,
    }));
  } else if (best.score.coverage >= THRESHOLDS.SUPPORT_COVERAGE) {
    verdict = 'supported';
    confidence = Math.min(0.99, 0.6 + best.score.coverage * 0.4);
  } else if (best.score.coverage < THRESHOLDS.NO_EVIDENCE_COVERAGE) {
    verdict = 'insufficient';
    confidence = Number((best.score.coverage * 0.5).toFixed(4));
    errors.push(makeError('E_NO_EVIDENCE', {
      query, retrieval_query: bridgedQuery, best_coverage: best.score.coverage,
      best_span_id: best.span.span_id, best_span_text: best.span.text,
    }));
  } else {
    verdict = 'insufficient';
    confidence = Number((best.score.coverage * 0.6).toFixed(4));
    errors.push(makeError('E_INSUFFICIENT_EVIDENCE', {
      query, retrieval_query: bridgedQuery,
      best_coverage: best.score.coverage, threshold: THRESHOLDS.SUPPORT_COVERAGE,
      best_span_id: best.span.span_id, best_span_text: best.span.text,
      unmatched_concepts: best.score.unmatched_tokens,
    }));
  }

  // 证据池污染后不再认证（原则 P4）
  //    检索到的候选片段中出现指令注入，说明该主张所处的证据池不可信。
  //    此时即便剩余片段看起来能支撑该主张，也不能给出「已验证」结论——
  //    因为无法排除「最相关的那段证据正是被投毒并已被隔离的那一段」。
  //    这与本项目「宁可拒答，不可虚构」的立场一致：污染即降级为需人工处理。
  if (quarantined > 0 && verdict === 'supported') {
    verdict = 'insufficient';
    confidence = Number(Math.min(confidence, 0.3).toFixed(4));
    errors.push(makeError('E_INJECTION_SUSPECTED', {
      mode: 'evidence_pool_tainted',
      quarantined_spans: quarantined,
      note: '该主张的候选证据池中存在被隔离的注入片段，因此不予认证。',
      best_span_id: bestSpan.span_id,
    }));
  }

  trace.push({
    step: 'aggregate', verdict, confidence,
    quarantined_spans: quarantined,
    polarity_conflicts: polarityConflicts.length,
    numeric_substitution: !!numericSubstitution,
    unsatisfied_quantities: unsatisfiedQ.length,
    relevant_spans: relevant.length,
  });

  const evidence = scored.slice(0, 5).map((s) => ({
    span_id: s.span.span_id,
    doc_id: s.span.doc_id,
    doc_title: s.span.doc_title,
    year: s.span.year,
    section: s.span.section,
    char_range: [s.span.start, s.span.end],
    text: s.span.text,
    verdict:
      s.span.span_id === bestSpan.span_id
        ? verdict
        : s.score.coverage >= THRESHOLDS.SUPPORT_COVERAGE
          ? 'supported'
          : 'insufficient',
    coverage: s.score.coverage,
    bm25: s.bm25,
    cross_lingual: analysis.cross_lingual,
    role:
      s.span.span_id === bestSpan.span_id && verdict === 'contradicted'
        ? 'counter_evidence'
        : s.score.coverage >= THRESHOLDS.SUPPORT_COVERAGE
          ? 'support'
          : 'candidate',
  }));

  return finish(claim, verdict, confidence, evidence, bestSpan, errors, {
    retrieval: {
      query: bridgedQuery, original_query: query,
      hits: search.hits.length, top_bm25: scored[0]?.bm25 ?? null,
    },
    coverage: best.score.coverage,
    numeric_score: claimQ.length === 0 ? 1 : Number(((claimQ.length - unsatisfiedQ.length) / claimQ.length).toFixed(4)),
    cross_lingual: analysis.cross_lingual,
    bridge_ratio: analysis.bridge_ratio,
    unmatched_concepts: best.score.unmatched_tokens,
    retrieval_query: bridgedQuery,
    thresholds: THRESHOLDS,
  }, trace);
}

function finish(claim, verdict, confidence, evidence, bestSpan, errors, metrics, trace) {
  return {
    claim,
    verdict,
    confidence: Number(confidence.toFixed(4)),
    evidence,
    primary_evidence: bestSpan
      ? {
          span_id: bestSpan.span_id,
          doc_id: bestSpan.doc_id,
          doc_title: bestSpan.doc_title,
          abs_url: bestSpan.doc_meta?.abs_url || null,
          char_range: [bestSpan.start, bestSpan.end],
          text: bestSpan.text,
        }
      : null,
    errors,
    metrics,
    trace,
  };
}

/* ------------------------ 引文真实性校验 ------------------------ */

/**
 * 校验一段「引文」是否真的出自所声称的 span。
 * 这是防「伪造引文」的最后一道闸：即使 span_id 合法，
 * 引文内容也可能被改写、拼接或截断取义。
 */
export function verifyQuote(spanId, quotedText, corpus) {
  let span;
  try {
    span = corpus.fetchSpan(spanId);
  } catch {
    return { ok: false, errors: [makeError('E_SPAN_NOT_FOUND', { span_id: spanId })], similarity: 0 };
  }
  const errors = [];
  const doc = corpus.doc(span.doc_id);
  if (span.start < 0 || span.end > doc.text.length || span.start >= span.end) {
    errors.push(makeError('E_SPAN_OUT_OF_RANGE', {
      span_id: spanId, char_range: [span.start, span.end], doc_length: doc.text.length,
    }));
  }

  const norm = (s) =>
    String(s || '').replace(/[\s\u00a0]+/g, ' ').replace(/[“”"']/g, '"').trim().toLowerCase();
  const a = norm(quotedText);
  const b = norm(span.text);

  let similarity = 0;
  if (a.length > 0) {
    if (b.includes(a)) similarity = 1;
    else {
      const grams = (s, n = 3) => {
        const set = new Set();
        for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
        return set;
      };
      const ga = grams(a);
      const gb = grams(b);
      let inter = 0;
      for (const g of ga) if (gb.has(g)) inter++;
      similarity = (2 * inter) / Math.max(1, ga.size + gb.size);
    }
  }

  if (similarity < 1 - THRESHOLDS.QUOTE_NORM_TOLERANCE) {
    errors.push(makeError('E_QUOTE_MISMATCH', {
      span_id: spanId,
      claimed_quote: quotedText,
      actual_span_text: span.text,
      similarity: Number(similarity.toFixed(4)),
    }));
  }

  return { ok: errors.length === 0, span, similarity: Number(similarity.toFixed(4)), errors };
}
