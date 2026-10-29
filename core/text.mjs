/**
 * core/text.mjs — 文本层：分句、分词、数字与极性抽取
 *
 * 本层是整个溯源系统的基础设施。核心约束：
 *   所有切分结果都必须携带相对文档权威文本的 **字符偏移 [start, end)**，
 *   因为 span 级引用的全部可信度都建立在「能精确定位回原文」这一点上。
 *   一旦偏移不可靠，后续的核验就是空中楼阁。
 */

import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* 分句                                                                */
/* ------------------------------------------------------------------ */

// 英文中常见的非句末缩写，避免误切
const EN_ABBREV = new Set([
  'et', 'al', 'e.g', 'i.e', 'cf', 'vs', 'fig', 'figs', 'eq', 'eqs', 'ref', 'refs',
  'sec', 'secs', 'no', 'nos', 'approx', 'dr', 'prof', 'mr', 'ms', 'mrs', 'inc',
  'ltd', 'co', 'dept', 'univ', 'vol', 'pp', 'ed', 'eds', 'resp', 'min', 'max',
  'avg', 'std', 'i.e.', 'e.g.', 'etc', 'u.s', 'u.k',
]);

/**
 * 将文本切分为句子，返回 [{ text, start, end }]，偏移相对入参 text。
 * 同时支持英文与中文标点。
 */
export function splitSentences(text, baseOffset = 0) {
  const out = [];
  const n = text.length;
  let i = 0;
  let sentStart = 0;

  const isCJK = (ch) => /[\u3000-\u9fff\uff00-\uffef]/.test(ch);

  const flush = (end) => {
    const raw = text.slice(sentStart, end);
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const lead = raw.length - raw.trimStart().length;
      out.push({
        text: trimmed,
        start: baseOffset + sentStart + lead,
        end: baseOffset + sentStart + lead + trimmed.length,
      });
    }
    sentStart = end;
  };

  while (i < n) {
    const ch = text[i];

    // 换行：段落边界也是句子边界（双换行强制断开）
    if (ch === '\n') {
      const isPara = text[i + 1] === '\n';
      // 单换行在中文文本里通常也是句边界；英文里可能是软换行
      if (isPara) {
        flush(i);
        while (i < n && text[i] === '\n') i++;
        sentStart = i;
        continue;
      }
      i++;
      continue;
    }

    // 中文句末标点
    if (isCJK(ch) && /[。！？；]/.test(ch)) {
      let j = i + 1;
      while (j < n && /["'"'”’）」』]/.test(text[j])) j++;
      flush(j);
      i = j;
      continue;
    }

    // 英文句末标点
    if (ch === '.' || ch === '!' || ch === '?') {
      // 处理省略号 / 小数 / 缩写
      if (ch === '.' && /\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) {
        i++;
        continue; // 小数点
      }
      let j = i + 1;
      while (j < n && /["'"'”’)\]]/.test(text[j])) j++;

      const after = text.slice(j, j + 2);
      const nextCh = text[j];
      const boundary =
        nextCh === undefined ||
        nextCh === '\n' ||
        /[A-Z"“（(\d]/.test(nextCh) ||
        isCJK(nextCh) ||
        /^\s/.test(after);

      if (ch === '.' && !boundary) {
        i++;
        continue;
      }

      // 缩写排除
      if (ch === '.') {
        const before = text.slice(Math.max(0, i - 12), i).match(/([A-Za-z.]+)$/)?.[1] || '';
        const low = before.toLowerCase().replace(/\.$/, '');
        // 注意 before 为空的情况：句号前若是非字母字符（如 ")"、"数字"、"引号"），
        // 说明这不是缩写而是真正的句末标点，必须切分。
        // 早期版本用 before.length <= 1 一并跳过，导致 "( Section 2 )." 这种
        // 句末不切分，span 被拉长成跨句长片段，引用精度随之下降。
        if (before && (EN_ABBREV.has(low) || /^[A-Z]$/.test(before) || before.length <= 1)) {
          i++;
          continue;
        }
      }
      if (boundary || ch !== '.') {
        flush(j);
        i = j;
        continue;
      }
      i++;
      continue;
    }

    i++;
  }
  flush(n);
  return out;
}

/* ------------------------------------------------------------------ */
/* 分词                                                                */
/* ------------------------------------------------------------------ */

/**
 * 统一分词：英文按词，中文按字 + 双字组合（中文信息检索的通行做法）。
 * 返回小写 token 数组。
 */
export function tokenize(s) {
  const text = String(s || '').toLowerCase();
  const tokens = [];

  const re = /[\u3400-\u9fff]+|[a-z]+(?:['’\-][a-z]+)*|\d+(?:[.,]\d+)*%?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (/[\u3400-\u9fff]/.test(tok)) {
      // 中文：单字
      for (const ch of tok) tokens.push(ch);
      // 中文：双字
      for (let i = 0; i + 1 < tok.length; i++) tokens.push(tok.slice(i, i + 2));
    } else if (/^\d/.test(tok)) {
      // 数字归一化：千分位逗号在多语言/多来源文本里写法不一，必须拉平，
      // 否则 "2,280" 与 "2280" 会被当成两个不同的 token，导致数值一致性校验误判。
      tokens.push(tok.replace(/,/g, ''));
    } else {
      tokens.push(tok);
    }
  }
  return tokens;
}

/** 停用词（英文为主，中文虚词单字） */
const STOP = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'by', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'as', 'it', 'its', 'this',
  'that', 'these', 'those', 'we', 'our', 'they', 'their', 'he', 'she', 'his',
  'her', 'from', 'but', 'not', 'no', 'can', 'could', 'will', 'would', 'may',
  'might', 'must', 'shall', 'should', 'do', 'does', 'did', 'has', 'have', 'had',
  'than', 'then', 'so', 'such', 'which', 'who', 'whom', 'what', 'when', 'where',
  'how', 'also', 'into', 'about', 'over', 'more', 'most', 'some', 'any', 'all',
  '的', '了', '是', '在', '和', '与', '及', '或', '而', '被', '把', '对', '从',
  '为', '以', '之', '其', '该', '等', '中', '上', '下', '有', '会', '能', '可',
  '这', '那', '我', '们', '他', '她', '它', '并', '且', '即', '则', '也', '都',
]);

export function contentTokens(s) {
  return tokenize(s).filter((t) => !STOP.has(t) && t.length > 0);
}

/* ------------------------------------------------------------------ */
/* 数字 / 单位 抽取                                                    */
/* ------------------------------------------------------------------ */

const UNIT_ALIASES = {
  '%': ['%', 'percent', 'percentage', '百分点', '百分比'],
  'x': ['x', '×', 'times', '倍'],
  'k': ['k', 'thousand', '千'],
  'm': ['m', 'million', '百万'],
  'b': ['b', 'billion', '十亿'],
};

/**
 * 抽取文本中的数量表达，归一化为 { value, unit, raw }。
 * 用于「数字一致性校验」——文献总结中最典型、也最危险的幻觉就是数字被改写。
 */
/**
 * 结构化引用编号的前缀词。这些词后面的数字是「编号」而不是「量」，
 * 若把它们当成数量参与一致性校验，"Section 2" 会被误判成主张里的数值。
 */
const REF_WORDS = /(section|sec\.?|table|tab\.?|figure|fig\.?|equation|eq\.?|appendix|chapter|chap\.?|step|listing|algorithm|alg\.?|定理|表|图|章节|附录|步骤)\s*$/i;

export function extractQuantities(s) {
  const text = String(s || '');
  const out = [];
  // 严格要求两侧都是非标识符边界：这样 "gpt-4-0613"、"LLaMA-2"、"v3.5" 里的数字
  // 会被正确排除，只有真正的「数量表达」才进入校验。
  const re = /(?<![A-Za-z0-9_\-.])(\d+(?:[.,]\d+)?)(?![A-Za-z0-9_\-])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 引用编号（Section 2 / 表 3 / Figure 4）不是量
    const before = text.slice(Math.max(0, m.index - 14), m.index);
    if (REF_WORDS.test(before)) continue;
    // 单独跟随单位前缀字母（如 2 k、3 m）时保留原逻辑
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    const unitM = tail.match(/^\s*(%|percent|percentage|×|x|times|k|m|b|million|billion|thousand|倍|百分点)\b/i);
    const rawNum = m[1].replace(/,/g, '');
    const v = Number(rawNum);
    if (!Number.isFinite(v)) continue;
    let unit = (unitM ? unitM[1] : '').toLowerCase();
    for (const [canon, alts] of Object.entries(UNIT_ALIASES)) {
      if (alts.includes(unit)) {
        unit = canon;
        break;
      }
    }
    out.push({ value: v, unit: unit || '', raw: (m[0] + (unitM ? unitM[0] : '')).trim() });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 否定极性 / 主张强度                                                 */
/* ------------------------------------------------------------------ */

const NEGATION_CUES = [
  'not', 'no', 'never', 'none', 'neither', 'nor', 'cannot', "can't", "don't",
  "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "won't", 'without',
  'lack', 'lacks', 'lacking', 'fail', 'fails', 'failed', 'unable', 'refuse',
  'refuses', 'unreliable', 'ineffective', 'useless', 'poorly',
  '不', '没有', '未', '无', '非', '无法', '并非', '不能', '不会', '不能', '缺乏',
  '拒绝', '失败', '不可靠', '无效', '不足', '欠佳', '较差',
];

/**
 * 中文里的「伪否定」：这些词含有否定字，但语义不是否定。
 * 若不排除，「不仅」「不但」会被当成否定表达，直接翻转极性判断。
 */
const ZH_NEGATION_EXCEPTIONS = ['不仅', '不但', '不只', '不失为', '不妨', '不论', '不管', '无论', '不光', '不无'];

/**
 * 句子极性检测。
 *
 * 关键实现细节：**按位置计数，而不是按线索字符串计数**。
 * 早期版本让「并非」与它内部包含的「非」各计一次，奇偶校验被翻转，
 * 结果「X 并非由 Y 生成」这种明确的反事实被判成了 affirmed —— 假阴性。
 * 假阴性比假阳性危险得多：假阳性只是拒绝输出，假阴性是把错误结论放行。
 * 现在改为把所有否定线索的出现位置收集为区间，重叠的只保留最长者，
 * 再对最终互不重叠的线索数做奇偶判断。
 */
export function polarityOf(s) {
  const raw = String(s || '');
  const text = raw.toLowerCase();

  // 先把伪否定从匹配空间中挖掉，避免其内部字符被误判
  let masked = text;
  for (const ex of ZH_NEGATION_EXCEPTIONS) {
    masked = masked.split(ex).join('\u0000'.repeat(ex.length));
  }

  const spans = [];
  for (const cue of NEGATION_CUES) {
    const isLatin = /^[a-z']+$/.test(cue);
    if (isLatin) {
      const pat = cue.replace(/'/g, "['" + String.fromCharCode(8217) + "]");
      const re = new RegExp('(^|[^a-z])' + pat + '([^a-z]|$)', 'g');
      let m;
      while ((m = re.exec(masked)) !== null) {
        const start = m.index + m[1].length;
        spans.push({ cue: cue, start: start, end: start + cue.length });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    } else {
      let from = 0;
      for (;;) {
        const idx = masked.indexOf(cue, from);
        if (idx < 0) break;
        // 被挖空的区域不算命中
        if (masked.slice(idx, idx + cue.length).indexOf('\u0000') >= 0) {
          from = idx + 1;
          continue;
        }
        spans.push({ cue: cue, start: idx, end: idx + cue.length });
        from = idx + 1;
      }
    }
  }

  // 重叠线索只保留最长者（如「并非」优先于「非」）
  spans.sort((a, b2) => a.start - b2.start || (b2.end - b2.start) - (a.end - a.start));
  const kept = [];
  for (const sp of spans) {
    if (kept.some((k) => sp.start < k.end && k.start < sp.end)) continue;
    kept.push(sp);
  }

  const count = kept.length;
  return {
    negated: count % 2 === 1,
    count: count,
    hits: [...new Set(kept.map((k) => k.cue))],
  };
}

// 主张强度：从「谨慎推测」到「强断言」
// 注意：这些是**认识论修饰词**，衡量的是「把话说得多满」，
// 不属于事实性内容概念。它们必须由 strengthOf 单独评判，
// 而不能参与覆盖率计算——否则「证明」这个词本身就会因为没有
// 出现在证据里而拉低覆盖率，把「强度越权」误判成「依据不足」。
export const HEDGE = [
  'may', 'might', 'could', 'suggest', 'suggests', 'suggesting', 'indicate',
  'indicates', 'likely', 'possibly', 'possible', 'potential', 'potentially',
  'tend', 'tends', 'preliminary', 'appears', 'seems', 'can help', 'might help',
  'should be interpreted', 'limited evidence', 'hypothesis', 'conjecture',
  '可能', '或许', '提示', '推测', '初步', '倾向', '似乎', '有待', '尚需', '有望',
  '表明', '指出', '暗示', '或可', '在一定程度上', '部分', '某些',
];
export const STRONG = [
  'prove', 'proves', 'proven', 'demonstrate', 'demonstrates', 'establish',
  'establishes', 'conclusively', 'definitively', 'proves that', 'shows that',
  'confirms', 'confirm', 'guarantees', 'always', 'never fails', 'all', 'none',
  '证明', '证实', '确立', '完全', '全部', '全都', '所有', '必然', '一定', '毫无疑问',
  '首次', '唯一', '彻底', '根本', '完全消除', '彻底解决',
];

/**
 * 主张强度评分：strong=2, neutral=1, hedge=0。
 * 用于检测「证据只能说可能，结论却说证明」这类**强度越权**。
 */
export function strengthOf(s) {
  const text = ` ${String(s || '').toLowerCase()} `;
  let strong = 0;
  let hedge = 0;
  const hits = { strong: [], hedge: [] };
  for (const w of STRONG) {
    if (text.includes(w)) {
      strong += 1;
      hits.strong.push(w);
    }
  }
  for (const w of HEDGE) {
    if (text.includes(w)) {
      hedge += 1;
      hits.hedge.push(w);
    }
  }
  const level = strong > 0 && hedge === 0 ? 2 : hedge > 0 && strong === 0 ? 0 : 1;
  return { level, strong, hedge, hits };
}

export const STRENGTH_LABEL = { 0: 'hedged', 1: 'neutral', 2: 'strong' };

/* ------------------------------------------------------------------ */
/* 实体线索（大写专名 / 技术术语）                                      */
/* ------------------------------------------------------------------ */

export function namedEntities(s) {
  const out = new Set();
  for (const m of String(s || '').matchAll(/\b([A-Z][A-Za-z0-9\-]*(?:\s+[A-Z][A-Za-z0-9\-]*){0,3})\b/g)) {
    const t = m[1].trim();
    if (t.length > 1) out.add(t);
  }
  // 含数字的模型/基准名，如 GPT-4o、LLaMA-2、TruthfulQA
  for (const m of String(s || '').matchAll(/\b([A-Za-z]+-?\d+[A-Za-z0-9]*)\b/g)) out.add(m[1]);
  return [...out];
}

export function normalizeWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function charOffsetOfContext(docText, needle, approx = 0) {
  const i = docText.indexOf(needle, Math.max(0, approx - 2000));
  return i;
}

export function sha256Hex(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}
