/**
 * core/corpus.mjs — 语料库加载、span 索引与 BM25 检索
 *
 * 关键概念：**span（证据片段）**
 *   语料中每一句话被登记为一个 span，拥有一个**确定性可复现**的 ID：
 *       <doc_id>::<char_start>-<char_end>
 *   该 ID 直接编码了它在原文中的字符区间，因此：
 *     - 同一个语料库 → 同一 ID 永远指向同一段文字
 *     - 核验结论里的每一条引用，都可以被人工一键回溯到原文精确位置
 *   这是「强制提供原文依据」能够被外部审计的前提。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSentences, contentTokens, normalizeWs } from './text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = path.resolve(__dirname, '..', 'corpus', 'corpus.json');

/**
 * 不可作为证据的章节。
 * 参考文献列表本身是「引用字符串」而非学术断言，Acknowledgments 同理；
 * 若允许它们充当证据，一条主张就可能被「某处提到过这个词」这种伪支撑通过核验。
 * 这类片段仍然保留在语料里（便于审计），但默认不参与检索。
 */
const NON_CITABLE_SECTION = /^(references|bibliography|acknowledg|acknowledgment|references and notes|参考文献|致谢)\b/i;
const NON_CITABLE_EXACT = new Set(['references', 'bibliography', 'acknowledgments', 'acknowledgements', 'references and notes']);

function isNonCitable(section) {
  const s = String(section || '').trim().toLowerCase();
  if (NON_CITABLE_EXACT.has(s)) return true;
  return NON_CITABLE_SECTION.test(s);
}

export class CorpusError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export class Corpus {
  constructor(data, { corpusPath } = {}) {
    this.meta = {
      corpus_id: data.corpus_id,
      built_at: data.built_at,
      domain: data.domain,
      doc_count: data.doc_count,
      fulltext_count: data.fulltext_count,
      total_chars: data.total_chars,
      content_sha256: data.content_sha256,
      license_note: data.license_note,
      sources: data.sources,
      corpus_path: corpusPath,
    };
    this.docs = new Map();
    this.spans = new Map();      // span_id -> span
    this.spansByDoc = new Map(); // doc_id -> span[]
    this.postings = new Map();   // token -> Map(span_id -> tf)
    this.df = new Map();         // token -> doc freq (over spans)
    this.totalLen = 0;
    this.avgLen = 1;

    for (const d of data.docs) this._addDoc(d);
    this._finalizeIndex();
  }

  _addDoc(d) {
    const doc = {
      doc_id: d.doc_id,
      title: d.title,
      authors: d.authors || [],
      year: d.year,
      published: d.published,
      primary_category: d.primary_category,
      abs_url: d.abs_url,
      html_url: d.html_url,
      text_kind: d.text_kind,
      text: d.text,
      chars: d.chars ?? d.text.length,
      sections: d.sections || [],
    };
    this.docs.set(doc.doc_id, doc);

    const sents = splitSentences(doc.text, 0);
    const list = [];
    sents.forEach((s, idx) => {
      const span = {
        span_id: `${doc.doc_id}::${s.start}-${s.end}`,
        doc_id: doc.doc_id,
        doc_title: doc.title,
        year: doc.year,
        start: s.start,
        end: s.end,
        sent_idx: idx,
        section: this._sectionAt(doc, s.start),
        text: s.text,
        citable: !isNonCitable(this._sectionAt(doc, s.start)),
      };
      this.spans.set(span.span_id, span);
      list.push(span);
    });
    this.spansByDoc.set(doc.doc_id, list);
  }

  _sectionAt(doc, offset) {
    let cur = doc.sections[0]?.name || 'Body';
    for (const s of doc.sections) {
      if (offset >= s.start) cur = s.name;
      else break;
    }
    return cur;
  }

  _finalizeIndex() {
    for (const span of this.spans.values()) {
      const toks = contentTokens(span.text);
      span.len = toks.length;
      this.totalLen += toks.length;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      span.tf = tf;
      for (const t of tf.keys()) {
        if (!this.postings.has(t)) this.postings.set(t, new Map());
        this.postings.get(t).set(span.span_id, tf.get(t));
        this.df.set(t, (this.df.get(t) || 0) + 1);
      }
    }
    this.avgLen = this.totalLen / Math.max(1, this.spans.size);
  }

  /** 逆文档频率（对 span 粒度） */
  idf(token) {
    const n = this.spans.size;
    const df = this.df.get(token) || 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  doc(docId) {
    return this.docs.get(docId) || null;
  }

  /** 按 span_id 精确取回证据片段（含上下文） */
  fetchSpan(spanId) {
    const span = this.spans.get(spanId);
    if (!span) {
      throw new CorpusError('E_SPAN_NOT_FOUND', `证据片段不存在：${spanId}`, { span_id: spanId });
    }
    const doc = this.docs.get(span.doc_id);
    const list = this.spansByDoc.get(span.doc_id);
    const i = span.sent_idx;
    return {
      ...span,
      doc_meta: {
        title: doc.title,
        authors: doc.authors,
        year: doc.year,
        abs_url: doc.abs_url,
        html_url: doc.html_url,
        text_kind: doc.text_kind,
      },
      context_before: i > 0 ? list[i - 1].text : '',
      context_after: i + 1 < list.length ? list[i + 1].text : '',
      // 原文精确切片，供人工回溯校验
      verbatim: doc.text.slice(span.start, span.end),
    };
  }

  /** BM25 检索：返回 top-k 证据片段 */
  search(query, { k = 8, docFilter = null, minTokenHits = 1, includeNonCitable = false } = {}) {
    const qTokens = contentTokens(query);
    if (qTokens.length === 0) {
      throw new CorpusError('E_EMPTY_QUERY', '检索式为空或不含有效实词', { query });
    }
    const k1 = 1.2;
    const b = 0.75;
    const scores = new Map();
    const uniq = [...new Set(qTokens)];

    for (const t of uniq) {
      const posting = this.postings.get(t);
      if (!posting) continue;
      const idf = this.idf(t);
      const qtf = qTokens.filter((x) => x === t).length;
      for (const [spanId, tf] of posting) {
        const span = this.spans.get(spanId);
        if (!includeNonCitable && span.citable === false) continue;
        if (docFilter && !docFilter(span)) continue;
        const denom = tf + k1 * (1 - b + (b * span.len) / this.avgLen);
        const s = idf * ((tf * (k1 + 1)) / denom) * (1 + Math.log(1 + qtf));
        scores.set(spanId, (scores.get(spanId) || 0) + s);
      }
    }

    if (scores.size === 0) {
      return { query, hits: [], reason: 'no_token_overlap' };
    }

    let hits = [...scores.entries()]
      .map(([spanId, score]) => {
        const span = this.spans.get(spanId);
        const hitTokens = uniq.filter((t) => span.tf.has(t));
        return { span, score, hit_tokens: hitTokens, hit_count: hitTokens.length };
      })
      .filter((h) => h.hit_count >= minTokenHits);

    // 归一化 + 覆盖率（命中 query 词占比），避免长句用高频词刷分
    const maxScore = Math.max(...hits.map((h) => h.score), 1e-9);
    hits = hits
      .map((h) => ({
        span_id: h.span.span_id,
        doc_id: h.span.doc_id,
        doc_title: h.span.doc_title,
        year: h.span.year,
        section: h.span.section,
        text: h.span.text,
        char_range: [h.span.start, h.span.end],
        bm25: Number(h.score.toFixed(4)),
        bm25_norm: Number((h.score / maxScore).toFixed(4)),
        query_token_coverage: Number((h.hit_count / uniq.length).toFixed(4)),
        hit_tokens: h.hit_tokens,
      }))
      .sort((a, b2) => b2.bm25 - a.bm25 || b2.query_token_coverage - a.query_token_coverage)
      .slice(0, k);

    return { query, hits, reason: 'ok' };
  }

  /** 供前端/报告使用的语料概览 */
  overview() {
    const byCat = {};
    const byYear = {};
    for (const d of this.docs.values()) {
      byCat[d.primary_category] = (byCat[d.primary_category] || 0) + 1;
      if (d.year) byYear[d.year] = (byYear[d.year] || 0) + 1;
    }
    return {
      ...this.meta,
      span_count: this.spans.size,
      vocabulary: this.postings.size,
      by_category: byCat,
      by_year: byYear,
      docs: [...this.docs.values()].map((d) => ({
        doc_id: d.doc_id,
        title: d.title,
        year: d.year,
        category: d.primary_category,
        text_kind: d.text_kind,
        chars: d.chars,
        span_count: this.spansByDoc.get(d.doc_id).length,
        abs_url: d.abs_url,
      })),
    };
  }
}

let _cache = null;

export function loadCorpus(corpusPath = DEFAULT_CORPUS) {
  if (_cache && _cache.meta.corpus_path === corpusPath) return _cache;
  if (!fs.existsSync(corpusPath)) {
    throw new CorpusError(
      'E_CORPUS_MISSING',
      `语料库文件不存在：${corpusPath}。请先运行 node tools/build-corpus.mjs 构建语料。`,
      { corpus_path: corpusPath },
    );
  }
  const data = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  _cache = new Corpus(data, { corpusPath });
  return _cache;
}

export { DEFAULT_CORPUS };
export { normalizeWs };
