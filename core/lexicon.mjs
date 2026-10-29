/**
 * core/lexicon.mjs — 中英术语桥（跨语言溯源）
 *
 * ===== 为什么需要这一层 =====
 * 真实场景是「中文提问 / 英文文献」。如果直接用中文主张去和英文证据做词覆盖，
 * 覆盖率恒为 0，系统会退化成「逢中文必拒答」——技术上正确，但毫无用处。
 *
 * 这一层提供**受控的术语映射**，把中文主张投影到英文检索/核验空间。
 * 关键设计约束（避免它变成"万能放行工具"）：
 *
 *   1. 只映射**领域术语**，不映射虚词、不映射逻辑关系词。
 *      不能把「因此」「表明」映射成 "therefore"/"indicate" 来凑覆盖率——
 *      那等于伪造语义支撑。
 *   2. 记录 `bridge_ratio`（成功映射的实词占比）并对外暴露。
 *      映射率低 = 系统无法确信该主张被证据覆盖 → 仍然走 insufficient。
 *   3. 数值与专名不受语言影响，始终按原文逐项比对，**桥接不参与数值校验**。
 *
 * 换言之：术语桥只解决「同一个概念换了语言」的问题，
 * 不解决「概念本身在证据里不存在」的问题。
 */

import { contentTokens, STRONG, HEDGE } from './text.mjs';

/** 领域术语表：中文 → 英文等价表述（可多选，检索时全部展开） */
const GLOSSARY = {
  // —— 幻觉与忠实性 ——
  幻觉: ['hallucination', 'hallucinations', 'hallucinate'],
  幻觉检测: ['hallucination detection', 'detecting hallucination'],
  幻觉缓解: ['hallucination mitigation', 'mitigating hallucination'],
  忠实性: ['faithfulness', 'faithful'],
  不忠实: ['unfaithful', 'faithlessness'],
  事实性: ['factuality', 'factual'],
  事实一致性: ['factual consistency', 'factual consistency'],
  真实性: ['truthfulness', 'veracity', 'factual'],
  可靠性: ['reliability', 'reliable', 'trustworthiness'],
  可信: ['trustworthy', 'trustworthiness'],
  谬误: ['fallacy', 'misinformation'],
  错误信息: ['misinformation', 'disinformation'],
  虚构: ['fabrication', 'fabricated', 'confabulation'],
  捏造: ['fabrication', 'fabricated'],

  // —— 归因与引用 ——
  归因: ['attribution', 'attributions', 'attributable'],
  可归因性: ['attributability', 'attribution'],
  引用: ['citation', 'citations', 'cite', 'citing'],
  引文: ['citation', 'cited text', 'reference'],
  引用生成: ['citation generation', 'citation text generation'],
  可验证: ['verifiable', 'verifiability'],
  可验证性: ['verifiability', 'verifiable'],
  溯源: ['provenance', 'attribution', 'traceability'],
  证据: ['evidence', 'evidences'],
  支撑: ['support', 'supports', 'supporting'],
  反驳: ['refute', 'refutes', 'refuting', 'contradict'],
  判别: ['discriminate', 'distinguish'],

  // —— 检索增强 ——
  检索增强生成: ['retrieval-augmented generation', 'retrieval augmented generation', 'RAG'],
  检索增强: ['retrieval-augmented', 'retrieval augmented'],
  检索: ['retrieval', 'retrieve', 'retrieval'],
  检索器: ['retriever', 'retrievers'],
  上下文: ['context', 'contexts'],
  上下文忠实: ['context faithful', 'context-faithfulness'],
  知识冲突: ['knowledge conflict', 'conflicting knowledge'],
  分块: ['chunking', 'chunk', 'chunks'],
  段落分块: ['chunking strategies', 'passage chunking'],

  // —— 事实核查 ——
  事实核查: ['fact verification', 'fact-checking', 'fact checking'],
  科学主张: ['scientific claim', 'scientific claims'],
  科学主张核查: ['scientific claim verification'],
  主张: ['claim', 'claims'],
  标注: ['annotation', 'annotations', 'annotated'],
  词级标注: ['word-level annotation', 'word-level annotations', 'word level annotation'],
  标注者: ['annotators', 'annotator'],
  数据集: ['dataset', 'datasets', 'corpus'],
  语料库: ['corpus', 'corpora'],
  基准: ['benchmark', 'benchmarks'],
  测试集: ['test set', 'evaluation set'],
  评测: ['evaluation', 'evaluate', 'benchmarking'],
  标注一致性: ['inter-annotator agreement', 'annotation agreement'],

  // —— 模型与训练 ——
  大语言模型: ['large language model', 'large language models', 'LLM', 'LLMs'],
  语言模型: ['language model', 'language models'],
  模型: ['model', 'models'],
  生成: ['generation', 'generate', 'generated'],
  解码: ['decoding', 'decode'],
  自验证: ['self-verification', 'self verify', 'self-verifying'],
  自一致性: ['self-consistency'],
  强化学习: ['reinforcement learning'],
  监督微调: ['supervised fine-tuning', 'fine-tuning'],
  对齐: ['alignment', 'align', 'aligned'],
  提示: ['prompt', 'prompts'],
  提示集: ['prompt set', 'prompt sets'],
  主题: ['topic', 'topics'],
  领域: ['domain', 'domains'],
  长文本: ['long-form', 'long form', 'long-form text'],
  开放式: ['open-domain', 'open domain'],

  // —— 自然语言推理 ——
  自然语言推理: ['natural language inference', 'NLI'],
  蕴含: ['entailment', 'entail', 'entails'],
  矛盾: ['contradiction', 'contradictions', 'contradictory'],
  中立: ['neutral'],
  三分类: ['three-way', 'three-way classification'],

  事实: ['fact', 'facts', 'factual'],
  事实性: ['factuality', 'factual', 'fact', 'facts'],
  选定: ['selected', 'chosen', 'manually-selected', 'manually selected'],
  选择: ['select', 'selected', 'choose', 'chosen', 'pick'],
  挑选: ['selected', 'chosen', 'picked'],
  组成: ['consists', 'consist', 'composed of', 'comprises', 'made up of'],
  覆盖: ['covers', 'covering', 'spanning', 'across', 'span', 'over'],
  寻求: ['seeking', 'solicit', 'solicits', 'seek'],
  回复: ['responses', 'response'],
  评测: ['evaluation', 'evaluate', 'benchmark', 'benchmarking'],
  基准: ['benchmark', 'benchmarks'],
  不受支持: ['not-supported', 'unsupported', 'not supported', 'unfounded'],
  支持: ['support', 'supported', 'supports'],
  消除: ['eliminate', 'eliminates', 'eliminating', 'remove', 'removes'],
  降低: ['reduce', 'reduces', 'reducing', 'decrease', 'lower'],
  提升: ['increase', 'increases', 'improve', 'improves', 'raise'],
  分布: ['distribution', 'distributions'],
  区域: ['region', 'regions', 'area', 'areas'],
  概率: ['probability', 'probabilities', 'probability'],
  微调: ['finetuning', 'fine-tuning', 'finetune', 'fine-tune'],
  成本: ['cost', 'costs', 'cost-effective'],
  失败: ['failure', 'failures', 'fail'],
  回答: ['response', 'responses', 'answer', 'answers'],
  训练: ['train', 'trained', 'training'],
  人类: ['human', 'humans'],
  专家: ['expert', 'experts', 'expertise'],
  人工: ['manual', 'manually', 'manually-selected', 'manually selected', 'human'],
  问题: ['question', 'questions', 'problem', 'problems'],
  条目: ['entry', 'entries', 'item', 'items'],
  数量: ['number', 'count', 'amount'],
  规模: ['scale', 'size', 'large-scale'],
  比例: ['ratio', 'proportion', 'percentage'],
  结果: ['result', 'results'],
  结论: ['conclusion', 'conclusions', 'finding', 'findings'],
  研究: ['study', 'studies', 'research'],
  论文: ['paper', 'papers', 'article', 'articles'],
  作者: ['author', 'authors'],
  章节: ['section', 'sections'],
  表格: ['table', 'tables'],
  图: ['figure', 'figures'],
  语言: ['language', 'languages'],
  中文: ['Chinese'],
  英文: ['English'],
  文本: ['text', 'texts'],
  句子: ['sentence', 'sentences'],
  段落: ['paragraph', 'paragraphs', 'passage', 'passages'],
  答案: ['answer', 'answers', 'response', 'responses'],
  任务: ['task', 'tasks'],
  类型: ['type', 'types', 'category', 'categories'],
  场景: ['scenario', 'scenarios', 'setting', 'settings'],

  // —— 谓词与关系（均为实义概念，非逻辑连接词）——
  提出: ['propose', 'proposes', 'proposed', 'introduce', 'introduces', 'present', 'presents'],
  包含: ['contains', 'contains', 'consists of', 'comprises', 'includes'],
  覆盖: ['covers', 'covering', 'spanning', 'across', 'span'],
  提供: ['provides', 'provide', 'offering', 'offers', 'features', 'feature', 'featuring', 'comes with'],
  使用: ['use', 'uses', 'using', 'employed', 'utilize', 'leverage'],
  基于: ['based on', 'based', 'built on'],
  达到: ['achieves', 'reaches', 'attains', 'achieve'],
  导致: ['leads to', 'causes', 'results in', 'lead to'],
  表明: ['indicates', 'indicate', 'shows', 'suggests', 'demonstrates'],
  证明: ['proves', 'prove', 'demonstrates', 'demonstrate', 'establishes'],
  评估: ['evaluate', 'evaluates', 'assess', 'assessment'],
  比较: ['compare', 'compares', 'compared', 'comparison'],
  存在: ['exists', 'exist', 'there is', 'present in'],
  产生: ['produces', 'generate', 'generates', 'yields', 'produce'],
  需要: ['requires', 'require', 'needs', 'necessitates'],
  支持: ['supports', 'support', 'backed'],
  允许: ['allows', 'allow', 'enables', 'enable'],
  用于: ['used for', 'used in', 'for'],
  有助于: ['helps', 'help', 'assists', 'assist', 'facilitates'],
  能够: ['can', 'is able to', 'capable of'],
  可以: ['can', 'may', 'is able to'],
  目标是: ['aims to', 'goal is', 'targets'],
  分为: ['divided into', 'categorized into', 'classified into'],
  导致幻觉: ['causes hallucination', 'induces hallucination'],
  检测: ['detect', 'detects', 'detection'],
  抑制: ['suppress', 'suppresses', 'suppression', 'mitigate'],
  缓解: ['mitigate', 'mitigates', 'mitigation', 'alleviate'],

  // —— 指标 ——
  准确率: ['accuracy', 'accurate'],
  精确率: ['precision'],
  召回率: ['recall'],
  召回: ['recall'],
  分数: ['score', 'scores'],
  性能: ['performance'],
  提升: ['improve', 'improves', 'improvement', 'outperform'],
  超过: ['outperform', 'surpass', 'exceed'],
  显著: ['significant', 'significantly', 'substantial'],
  人工评估: ['human evaluation', 'human evaluation'],
  自动评估: ['automatic evaluation', 'automated evaluation'],
  错误率: ['error rate', 'rate of error'],
  一致: ['consistent', 'consistency', 'agreement'],

  // —— 方法 ——
  方法: ['method', 'methods', 'approach', 'approaches'],
  框架: ['framework', 'frameworks'],
  实验: ['experiment', 'experiments', 'experimental'],
  训练: ['training', 'train', 'trained'],
  推理: ['inference', 'reasoning'],
  注意力: ['attention'],
  机制: ['mechanism', 'mechanisms'],
};

/** 从术语表中构建「中文术语 → 英文字符串」的扁平映射 */
const FLAT = new Map();
for (const [zh, ens] of Object.entries(GLOSSARY)) {
  FLAT.set(zh, ens.join(' '));
}
/** 按中文术语长度降序，保证优先匹配长术语（"检索增强生成" 优于 "检索"） */
const ZH_TERMS = [...FLAT.keys()].sort((a, b) => b.length - a.length);

const CJK_RE = /[\u3400-\u9fff]/;

/**
 * 中文虚词/量词字符集。
 * 由纯虚词构成的碎片不承载任何可核查语义，若纳入概念单元，
 * 只会制造一个永远无法被证据覆盖的分母项，凭空压低覆盖率。
 * 它们的作用（否定极性）由 polarityOf 单独处理，不在这里参与覆盖计算。
 */
const ZH_FUNCTION_CHARS = new Set(
  '是 的 了 在 有 个 条 中 和 与 及 为 等 这 那 会 能 可 都 也 就 而 且 或 被 把 对 从 以 之 其 该 上 下 里 时 后 前 并 很 更 最 还 又 只 不 没 无 非 未 将 于 由 使 让 给 向 往 至 到 因 所 者 地 得 过 着 们 我 他 她 它 你 您 咱 此 些 每 各 另 别 某 诸 凡 若 则 即 乃 却 仍 尚 亦 已 曾 正 越 太 挺 蛮 一 二 三 两 个 些 种 类 者 的 之 其 经 被 将 已 由 使 让 以 于 至 等 所'.split(' '),
);

/**
 * 认识论修饰词（「证明」「可能」「初步」等）。
 * 它们表达的是主张的强度，而不是事实内容。
 * 若把它们算进概念覆盖率，会出现一个悖论：
 *   越强烈的措辞 → 越不可能出现在谨慎表述的证据里 → 覆盖率反而越低
 *   → 系统把它判成「依据不足」，而不是它真正的问题「强度越权」。
 * 因此这里把它们从覆盖率分母中摘出，交由 strengthOf 独立评判。
 */
const EPISTEMIC_ZH = [...new Set([...STRONG, ...HEDGE])]
  .filter((w) => /[\u3400-\u9fff]/.test(w))
  .sort((a, b) => b.length - a.length);

const EPISTEMIC_LATIN = [...new Set([...STRONG, ...HEDGE])]
  .filter((w) => !/[\u3400-\u9fff]/.test(w))
  .sort((a, b) => b.length - a.length);

function isFunctionFragment(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  const chars = [...t].filter((ch) => !/[\s\u3000-\u303f\uff00-\uffef]/.test(ch));
  if (chars.length === 0) return true;
  const fn = chars.filter((ch) => ZH_FUNCTION_CHARS.has(ch)).length;
  // 用比例而非「全为虚词」：中文长片段里往往夹杂量词与系动词
  // （如「是一个」「有个」），全等判定会把这些噪声放行成概念单元。
  return fn / chars.length >= 0.6;
}
const LATIN_RE = /[A-Za-z]/;

/** 判断文本是否为 CJK 主导 */
export function isCjkDominant(s) {
  const cjk = (String(s).match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (String(s).match(/[A-Za-z]/g) || []).length;
  return cjk > latin;
}

/**
 * 把中文主张投影为英文检索式（用于 BM25 检索）。
 * 术语表命中处替换为英文，未命中处保留原文。
 */
export function bridge(text) {
  const src = String(text || '');
  const mapped = [];
  let out = src;
  for (const zh of ZH_TERMS) {
    if (!out.includes(zh)) continue;
    const en = FLAT.get(zh);
    out = out.split(zh).join(` ${en} `);
    mapped.push({ zh, en });
  }
  const zhChunks = src.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const covered = zhChunks.filter((chunk) => mapped.some((m) => chunk.includes(m.zh))).length;
  const bridgeRatio = zhChunks.length === 0 ? 1 : covered / zhChunks.length;
  return {
    bridged: out.replace(/\s+/g, ' ').trim(),
    mapped_terms: mapped,
    bridge_ratio: Number(bridgeRatio.toFixed(4)),
  };
}

/**
 * 把主张解析为「概念单元」序列。
 *
 * 这是跨语言核验的核心数据结构。之所以不能把术语表直接展开成文本再分词：
 * 一个中文术语若展开为 4 个英文同义词，就会在分母里塞进 3 个天然不可能命中
 * 的 token，反而把真实被支持的主张稀释成「覆盖率极低」。
 *
 * 正确做法：一个概念 = 一个单元，单元内所有英文表述互为候选，命中任一即算覆盖。
 *
 * @returns {{units:Array, cross_lingual:boolean, bridge_ratio:number, mapped_terms:Array, unmapped_zh:Array}}
 */
export function analyzeClaimUnits(claim) {
  const src = String(claim || '');
  const units = [];
  const epistemic = [];
  const mappedTerms = [];
  const unmappedZh = [];
  const zhChunks = src.match(/[\u4e00-\u9fff]{2,}/g) || [];
  let mappedChunks = 0;

  // 先切出「非中文」片段（英文词、数字）——这些与语言无关，直接成为单元
  const segments = [];
  let cursor = 0;
  const re = /[\u3400-\u9fff]+/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > cursor) segments.push({ type: 'latin', text: src.slice(cursor, m.index) });
    segments.push({ type: 'cjk', text: m[0] });
    cursor = m.index + m[0].length;
  }
  if (cursor < src.length) segments.push({ type: 'latin', text: src.slice(cursor) });

  for (const seg of segments) {
    if (seg.type === 'latin') {
      for (const tok of seg.text.toLowerCase().match(/[a-z]+(?:['\u2019\-][a-z]+)*|\d+(?:[.,]\d+)*%?/g) || []) {
        const t = tok.replace(/,/g, '');
        if (EPISTEMIC_LATIN.includes(t)) {
          epistemic.push(t);
          continue;
        }
        units.push({ key: t, kind: 'latin', alts: [t], raw: tok });
      }
      continue;
    }
    // 中文片段：最长优先匹配术语表，未匹配部分保留为独立单元（会自然地不被覆盖）
    let rest = seg.text;
    let chunkMapped = false;
    while (rest.length > 0) {
      // 认识论修饰词先摘除：不进入覆盖率分母
      const ep = EPISTEMIC_ZH.find((w) => rest.startsWith(w));
      if (ep) {
        epistemic.push(ep);
        rest = rest.slice(ep.length);
        continue;
      }
      const hit = ZH_TERMS.find((zh) => rest.startsWith(zh));
      if (hit) {
        const alts = FLAT.get(hit).split(/[\s|]+/).filter(Boolean);
        units.push({ key: hit, kind: 'zh-term', alts: [...new Set(alts)], raw: hit });
        mappedTerms.push({ zh: hit, en: FLAT.get(hit) });
        chunkMapped = true;
        rest = rest.slice(hit.length);
        continue;
      }
      // 未命中：取最长可识别术语的起点，否则吃掉一个字
      const nextHit = ZH_TERMS
        .map((zh) => rest.indexOf(zh))
        .filter((idx) => idx > 0)
        .sort((a, b) => a - b)[0];
      const take = nextHit && nextHit > 0 ? nextHit : Math.min(2, rest.length);
      const piece = rest.slice(0, take);
      // 纯虚词碎片不构成概念单元（否则会凭空压低覆盖率）
      if (!isFunctionFragment(piece)) {
        units.push({ key: piece, kind: 'zh-unmapped', alts: [piece], raw: piece });
        unmappedZh.push(piece);
      }
      rest = rest.slice(take);
    }
    if (chunkMapped) mappedChunks++;
  }

  const bridgeRatio = zhChunks.length === 0 ? 1 : Number((mappedChunks / zhChunks.length).toFixed(4));
  const crossLingual = isCjkDominant(claim) && unmappedZh.length + mappedTerms.length > 0;

  return {
    units,
    cross_lingual: crossLingual,
    bridge_ratio: bridgeRatio,
    mapped_terms: mappedTerms,
    unmapped_zh: [...new Set(unmappedZh)],
    bridged_query: bridge(claim).bridged,
    concept_count: units.length,
    epistemic_markers: [...new Set(epistemic)],
  };
}

/** 兼容入口：返回核验所需的跨语言上下文 */
export function prepareBilingual(claim) {
  return analyzeClaimUnits(claim);
}

export { GLOSSARY };
