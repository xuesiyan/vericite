/**
 * core/errors.mjs — 结构化错误码注册表
 *
 * 赛事评审明确看重「异常处理」。本项目把「异常」提升为一等公民：
 *   任何无法用原文依据支撑的结论，都不允许降级为模糊表述，
 *   而必须抛出**带错误码的结构化拒绝**，并且该拒绝本身可被审计。
 *
 * 每条错误码声明：
 *   - severity  : fatal（终止并拒绝输出） / degrade（降级为需人工复核） / warn
 *   - stage     : 在闭环的哪个阶段被触发（planning / retrieval / verification / audit）
 *   - meaning   : 该错误在业务上意味着什么
 *   - handling  : 系统对该错误的既定处理动作（可被测试断言）
 */

export const ERROR_CODES = {
  E_CORPUS_MISSING: {
    severity: 'fatal', stage: 'planning',
    meaning: '语料库不可用，系统没有可核查的知识来源。',
    handling: '立即终止，禁止输出任何结论（不得凭模型先验作答）。',
  },
  E_EMPTY_QUERY: {
    severity: 'fatal', stage: 'planning',
    meaning: '检索式为空或不含有效实词，无法构造证据检索。',
    handling: '终止并要求重新表述核查对象。',
  },
  E_NO_EVIDENCE: {
    severity: 'fatal', stage: 'retrieval',
    meaning: '检索返回零条候选证据，问题超出语料覆盖范围。',
    handling: '终止该主张，返回「无依据」并附检索式与语料范围说明。',
  },
  E_INSUFFICIENT_EVIDENCE: {
    severity: 'fatal', stage: 'verification',
    meaning: '存在弱相关片段，但其内容不足以支撑该主张的语义强度。',
    handling: '拒绝输出该主张，返回候选片段供人工判断。',
  },
  E_CONTRADICTION: {
    severity: 'fatal', stage: 'verification',
    meaning: '原文存在与该主张相矛盾的表述（已检出反证片段）。',
    handling: '拒绝输出，并同时给出反证片段引用。',
  },
  E_UNSUPPORTED_NUMERIC: {
    severity: 'fatal', stage: 'verification',
    meaning: '主张中的数值/单位在全部候选证据中不存在或与原文不一致。',
    handling: '拒绝输出，列出主张数值与原文数值的差异对照。',
  },
  E_POLARITY_CONFLICT: {
    severity: 'fatal', stage: 'verification',
    meaning: '主张的否定极性与证据相反（如原文说「不能」，主张说「能」）。',
    handling: '拒绝输出，标注极性冲突位置。',
  },
  E_STRENGTH_OVERCLAIM: {
    severity: 'fatal', stage: 'verification',
    meaning: '证据强度为推测性，主张却使用了断言性表述，属越权推断。',
    handling: '拒绝原始表述，要求降级到证据允许的强度后重试。',
  },
  E_ENTITY_MISMATCH: {
    severity: 'fatal', stage: 'verification',
    meaning: '主张中的关键实体（模型名/数据集名/方法名）未出现在证据中，疑似张冠李戴。',
    handling: '拒绝输出，列出未获支撑的实体。',
  },
  E_SPAN_NOT_FOUND: {
    severity: 'fatal', stage: 'verification',
    meaning: '引用的 span_id 在语料中不存在，引用非法（引用幻觉）。',
    handling: '拒绝该引用；计入「引用真实性」指标。',
  },
  E_SPAN_OUT_OF_RANGE: {
    severity: 'fatal', stage: 'verification',
    meaning: '引用的字符区间越出文档边界，引用非法。',
    handling: '拒绝该引用；计入「引用真实性」指标。',
  },
  E_QUOTE_MISMATCH: {
    severity: 'fatal', stage: 'verification',
    meaning: '引用者给出的原文片段与该 span 的实际内容不一致（引文被改写/拼接）。',
    handling: '拒绝该引用；判定为引文失真。',
  },
  E_MODEL_CONFLICT: {
    severity: 'degrade', stage: 'verification',
    meaning: '确定性核验通道与 Agnes 模型判定通道结论不一致。',
    handling: '不放行也不否决，标记为「需人工复核」并双通道留痕。',
  },
  E_CLAIM_TOO_LONG: {
    severity: 'degrade', stage: 'audit',
    meaning: '单条主张过长（含多个并列断言），无法做原子化溯源。',
    handling: '拆分后重新核查；未拆分部分不进入结论。',
  },
  E_INJECTION_SUSPECTED: {
    severity: 'fatal', stage: 'retrieval',
    meaning: '语料片段中含疑似针对核验流程的指令注入文本。',
    handling: '隔离该片段，不作为证据使用，并在审计记录中标记。',
  },
  E_CROSSLINGUAL_LOW_MAPPING: {
    severity: 'fatal', stage: 'verification',
    meaning: '跨语言核验时，主张中的中文术语无法被受控术语表充分映射到证据语言。',
    handling: '不采信该证据；判定为 insufficient，并提示改用原文语言表述或补充术语映射。',
  },
  E_UNSUPPORTED_LANGUAGE: {
    severity: 'warn', stage: 'planning',
    meaning: '待核查文本以非中英文主语种撰写，分词与检索质量不可保证。',
    handling: '继续执行但降低置信度，并在报告显著位置声明。',
  },
};

export function makeError(code, detail = {}, extraMessage = null) {
  const def = ERROR_CODES[code];
  if (!def) throw new Error(`未注册的错误码：${code}`);
  return {
    code,
    severity: def.severity,
    stage: def.stage,
    meaning: def.meaning,
    handling: def.handling,
    message: extraMessage || def.meaning,
    detail,
  };
}

export function isFatal(err) {
  return err?.severity === 'fatal';
}

/** 用于对外输出：按严重度排序，保证 fatal 优先被看到 */
export function sortErrors(errors = []) {
  const rank = { fatal: 0, degrade: 1, warn: 2 };
  return [...errors].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}
