/**
 * core/model-channel.mjs — 通道 B 的真实实现：Agnes 官方网关「第二意见」
 *
 * ============================ 设计边界 ============================
 * 1. **零依赖**：仅用 Node ≥ 18 内置 fetch，不引入任何 npm 包。
 * 2. **默认关闭**：只有环境中存在 AGNES_API_KEY 且调用方显式要求时才发起网络请求；
 *    离线场景（回归测试、demo --all、AGH 无模型验证路径）行为与之前完全一致。
 * 3. **非对称仲裁不变**：本模块只负责「拿到模型的判定」，判定如何合并由
 *    core/audit.mjs 的 adjudicate() 决定——模型可以让一条主张被拦下（升级复核），
 *    但**永远不能**推翻确定性通道的否决。
 * 4. **封闭世界**：提示词明确要求模型只依据给出的证据片段判断，
 *    不允许用自身参数知识补足——否则就把「知识边界」这道防线拆掉了。
 * 5. **失败降级**：网关超时、返回垃圾、额度耗尽都不应让审计失败；
 *    此时退回纯确定性通道，并在结果中留痕（model_channel.error）。
 * ==================================================================
 */

import { auditDraft } from './audit.mjs';

export const MODEL_CHANNEL_DEFAULTS = Object.freeze({
  model: 'agnes-3.0-flash',
  baseUrl: 'https://api.agnes-ai.cn/v1',
  timeoutMs: 30_000,
  maxClaims: 12,
  evidenceSnippetChars: 220,
});

/** 模型通道是否具备启用条件（只检查凭据是否存在，不发网络请求） */
export function isModelChannelAvailable(env = process.env) {
  return Boolean(env.AGNES_API_KEY);
}

/** 从模型回复中宽容地提取 JSON 数组：容忍代码围栏、前后缀文本 */
export function extractJsonArray(text) {
  const s = String(text || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const KNOWN_VERDICTS = new Set(['supported', 'insufficient', 'contradicted']);

function buildPrompt(targets) {
  const lines = targets.map((c, i) => {
    const ev = c.primary_evidence?.text
      ? String(c.primary_evidence.text).slice(0, MODEL_CHANNEL_DEFAULTS.evidenceSnippetChars)
      : '（无候选证据片段）';
    return [
      `【主张 ${c.claim_id}】${c.claim}`,
      `（确定性通道初判：${c.verdict}）`,
      `【证据片段】${ev}`,
    ].join('\n');
  });
  return [
    '你是科研文献溯源核查系统的「第二意见」判定通道。系统工作在封闭世界设定下：',
    '你只能依据给出的【证据片段】判断主张，禁止使用你自身的知识补足证据。',
    '',
    ...lines,
    '',
    '请对每条主张独立给出判定，只输出一个 JSON 数组，不要输出任何其他文字：',
    '[{"claim_id":"C001","verdict":"supported|insufficient|contradicted","reason":"一句话理由"}]',
    'verdict 含义：supported=证据足以支撑该主张；insufficient=证据不足以判断；contradicted=证据与主张矛盾。',
  ].join('\n');
}

/**
 * 向 Agnes 网关请求一次「第二意见」。
 * @param {Array<{claim_id:string, claim:string, verdict:string, primary_evidence?:{text?:string}}>} claimRecords
 * @param {{env?:object, apiKey?:string, baseUrl?:string, model?:string, timeoutMs?:number,
 *          maxClaims?:number, fetchImpl?:Function}} opts
 * @returns {Promise<{verdicts:Array, meta:object|null, error:object|null}>}
 */
export async function askAgnesVerdicts(claimRecords, opts = {}) {
  const env = opts.env ?? process.env;
  const apiKey = opts.apiKey ?? env.AGNES_API_KEY;
  const targets = (claimRecords || []).filter((c) => c.claim_id && c.claim).slice(0, opts.maxClaims ?? MODEL_CHANNEL_DEFAULTS.maxClaims);

  if (!apiKey) {
    return { verdicts: [], meta: null, error: { code: 'MODEL_CHANNEL_DISABLED', message: '未设置 AGNES_API_KEY，模型通道未启用' } };
  }
  if (targets.length === 0) {
    return { verdicts: [], meta: null, error: null };
  }

  const baseUrl = String(opts.baseUrl ?? env.AGNES_BASE_URL ?? MODEL_CHANNEL_DEFAULTS.baseUrl).replace(/\/+$/, '');
  const model = opts.model ?? env.AGNES_MODEL ?? MODEL_CHANNEL_DEFAULTS.model;
  const timeoutMs = opts.timeoutMs ?? MODEL_CHANNEL_DEFAULTS.timeoutMs;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const t0 = Date.now();

  const baseMeta = { model, base_url: baseUrl, requested_claims: targets.length };

  let res;
  try {
    res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 1600,
        temperature: 0,
        messages: [
          { role: 'system', content: '你是严谨的文献核查判定通道，只输出 JSON。' },
          { role: 'user', content: buildPrompt(targets) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { verdicts: [], meta: { ...baseMeta, latency_ms: Date.now() - t0 }, error: { code: 'MODEL_CHANNEL_UNREACHABLE', message: `网关请求失败：${e?.message || e}` } };
  }

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()).slice(0, 200); } catch { /* 忽略正文解析失败 */ }
    return { verdicts: [], meta: { ...baseMeta, latency_ms: Date.now() - t0 }, error: { code: 'MODEL_CHANNEL_HTTP_ERROR', message: `网关返回 HTTP ${res.status} ${detail}` } };
  }

  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    return { verdicts: [], meta: { ...baseMeta, latency_ms: Date.now() - t0 }, error: { code: 'MODEL_CHANNEL_BAD_RESPONSE', message: `响应不是 JSON：${e?.message || e}` } };
  }

  const content = payload?.choices?.[0]?.message?.content ?? '';
  const arr = extractJsonArray(content);
  if (!arr) {
    return { verdicts: [], meta: { ...baseMeta, latency_ms: Date.now() - t0, completion_chars: String(content).length }, error: { code: 'MODEL_CHANNEL_UNPARSABLE', message: '模型未返回可解析的 JSON 判定数组' } };
  }

  const validIds = new Set(targets.map((c) => c.claim_id));
  const verdicts = [];
  const dropped = [];
  for (const item of arr) {
    const id = String(item?.claim_id || '').toUpperCase();
    const ver = String(item?.verdict || '').toLowerCase();
    if (!validIds.has(id)) { dropped.push({ claim_id: id, reason: 'unknown_claim_id' }); continue; }
    if (!KNOWN_VERDICTS.has(ver)) { dropped.push({ claim_id: id, reason: `illegal_verdict:${item?.verdict}` }); continue; }
    verdicts.push({ claim_id: id, verdict: ver, reason: String(item?.reason || '').slice(0, 300) });
  }

  return {
    verdicts,
    meta: {
      ...baseMeta,
      latency_ms: Date.now() - t0,
      prompt_tokens: payload?.usage?.prompt_tokens ?? null,
      completion_tokens: payload?.usage?.completion_tokens ?? null,
      returned: arr.length,
      dropped,
    },
    error: null,
  };
}

/**
 * 带真实模型通道的完整审计（可选启用）。
 *
 * 流程：先跑一遍纯确定性审计拿到逐条判定与主证据 → 拿这些材料向 Agnes 网关
 * 请求第二意见 → 再跑一遍确定性审计并把模型判定交给 adjudicate() 做非对称仲裁。
 * 确定性核验是纯函数，两遍结果完全一致；第二遍的开销换来的是账本完整
 * （模型通道的调用与响应都进入事件账本，可作 AGH execution records 证据）。
 */
export async function auditWithModelChannel(text, corpus, opts = {}) {
  const { modelChannel = true, ...rest } = opts;
  const pre = auditDraft(text, corpus, { ...rest, modelVerdicts: [] });

  const enabled = modelChannel && isModelChannelAvailable(opts.env ?? process.env);
  if (!enabled || pre.claims.length === 0) {
    pre.model_channel = { enabled: false, reason: enabled ? 'no_claims' : 'disabled_or_no_key' };
    return pre;
  }

  const channel = await askAgnesVerdicts(pre.claims, opts);

  // 把通道调用本身记入事件账本——这是「AGH 与模型闭环」的直接证据
  const preLedgerEvents = [
    { stage: 'tool_call', action: 'agnes_model_channel_request', model: channel.meta?.model, base_url: channel.meta?.base_url, claims: channel.meta?.requested_claims },
    channel.error
      ? { stage: 'tool_result', action: 'agnes_model_channel_error', code: channel.error.code, message: channel.error.message, latency_ms: channel.meta?.latency_ms }
      : { stage: 'tool_result', action: 'agnes_model_channel_response', verdicts: channel.verdicts, latency_ms: channel.meta?.latency_ms, usage: { prompt_tokens: channel.meta?.prompt_tokens, completion_tokens: channel.meta?.completion_tokens } },
  ];

  const final = auditDraft(text, corpus, { ...rest, modelVerdicts: channel.verdicts, preLedgerEvents });
  final.model_channel = {
    enabled: true,
    ...(channel.meta || {}),
    error: channel.error,
    verdict_count: channel.verdicts.length,
  };
  return final;
}
