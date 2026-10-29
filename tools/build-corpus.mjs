#!/usr/bin/env node
/**
 * build-corpus.mjs — 构建离线可复现的科研文献语料库
 *
 * 数据来源（全部为公开、可核查的真实文献）：
 *   1. arXiv API   : https://export.arxiv.org/api/query  —— 文献元数据 + 摘要
 *   2. arXiv HTML  : https://arxiv.org/html/{id}          —— 论文全文（仅部分论文提供）
 *
 * 设计要点：
 *   - 语料主题域刻意选为「AI 幻觉 / 引用可归因性 / 事实核查」，
 *     即本项目所解决问题的学术前沿本身 —— 语料与命题自洽。
 *   - 输出 docs[].text 为规范化后的**唯一权威文本**，所有 span 偏移
 *     均相对该文本计算，因此 span_id 完全可复现、可回溯定位。
 *   - 语料整体计算 sha256 指纹，写入 manifest，作为溯源证据的一部分。
 *
 * 用法：
 *   node tools/build-corpus.mjs [--offline-rebuild]
 *   --offline-rebuild 表示不联网，仅用已缓存的 raw 数据重新生成 corpus.json
 *
 * 注：本机 Node 使用系统证书库，若出现证书链错误，可设置
 *     NODE_TLS_REJECT_UNAUTHORIZED=0 （仅用于该一次性公开数据抓取）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'corpus', 'raw');
const OUT_FILE = path.join(ROOT, 'corpus', 'corpus.json');
const OFFLINE = process.argv.includes('--offline-rebuild');

const ARXIV_API = 'https://export.arxiv.org/api/query';

/** 主题域查询式：围绕「幻觉 / 归因 / 事实核查 / 检索增强忠实性 / 蕴含判定」 */
const QUERIES = [
  { key: 'hallucination-survey', q: 'abs:"hallucination" AND abs:"large language models"', n: 4 },
  { key: 'attribution', q: 'abs:"attribution" AND abs:"language model"', n: 4 },
  { key: 'rag-faithfulness', q: 'abs:"faithfulness" AND abs:"retrieval-augmented generation"', n: 4 },
  { key: 'claim-verification', q: 'abs:"scientific claim verification"', n: 4 },
  { key: 'nli-factverif', q: 'abs:"natural language inference" AND abs:"fact verification"', n: 4 },
  { key: 'self-verification', q: 'abs:"self-verification" AND abs:"language model"', n: 4 },
  { key: 'citation-generation', q: 'abs:"citation" AND abs:"text generation"', n: 4 },
  { key: 'factuality-eval', q: 'abs:"factuality" AND abs:"benchmark" AND abs:"language model"', n: 4 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* 网络层                                                              */
/* ------------------------------------------------------------------ */

async function httpGet(url, { retries = 3, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          'User-Agent':
            'VeriCite/1.0 (research-literature-provenance-hackathon; contact: participant)',
          Accept: '*/*',
        },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      // 温和退避，避免触发 arXiv 速率限制
      await sleep(3000 * (i + 1));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* arXiv Atom 解析（不引入外部依赖，手写轻量解析）                      */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    '#39': "'", '#34': '"', '#38': '&', '#x27': "'",
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z#0-9]+);/g, (m, e) => (e in named ? named[e] : m));
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function parseAtom(xml) {
  const entries = xml.split(/<entry>/i).slice(1);
  return entries.map((raw) => {
    const e = raw.split(/<\/entry>/i)[0];
    const idUrl = tagText(e, 'id');
    const arxivId = (idUrl.match(/abs\/([^v\s]+)(v\d+)?$/)?.[1] || '').trim();
    const authors = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map((m) => decodeEntities(m[1]).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const primary =
      e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/i)?.[1] ||
      tagText(e, 'arxiv:primary_category');
    const published = tagText(e, 'published');
    return {
      arxiv_id: arxivId,
      title: tagText(e, 'title'),
      abstract: tagText(e, 'summary'),
      authors,
      published: published.slice(0, 10),
      year: Number(published.slice(0, 4)) || null,
      primary_category: primary || '',
      comment: tagText(e, 'arxiv:comment'),
    };
  }).filter((p) => p.arxiv_id && p.title);
}

/* ------------------------------------------------------------------ */
/* arXiv HTML 全文抽取                                                 */
/* ------------------------------------------------------------------ */

/** 去掉 script/style/公式图片等噪声，将块级标签转为换行，再剥离标签 */
function htmlToTextBlocks(html) {
  let h = html;
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<(script|style|noscript|svg|math)[\s\S]*?<\/\1>/gi, ' ');

  // 记录标题层级，便于保留小节结构
  h = h.replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => {
    const t = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    return t ? `\n\n@@H${lvl}@@ ${t}\n` : '\n';
  });

  h = h.replace(/<li[^>]*>/gi, '\n- ');
  h = h.replace(/<\/(p|div|section|li|tr|h[1-6]|figcaption|blockquote|dd|dt)>/gi, '\n');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h);

  return h
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 arXiv HTML 中抽取正文（去掉导航/参考文献表） */
function extractFullText(html) {
  let body = html;
  const article = html.match(/<article[\s\S]*?<\/article>/i);
  if (article) body = article[0];
  const main = body.match(/<main[\s\S]*?<\/main>/i);
  if (main) body = main[0];

  let text = htmlToTextBlocks(body);
  // 截断参考文献之前的内容（参考文献列表本身不承载可核查主张）
  const refIdx = text.search(/\n@@H1@@\s*(References|Bibliography|REFERENCES)\b/);
  if (refIdx > 2000) text = text.slice(0, refIdx);
  return text.trim();
}

/** 从正文中切分出 sections（按 @@Hx@@ 标记） */
function splitSections(text) {
  const secs = [];
  const re = /@@H([1-4])@@\s*(.+)/g;
  let m;
  const marks = [];
  while ((m = re.exec(text)) !== null) {
    marks.push({ idx: m.index, end: m.index + m[0].length, level: Number(m[1]), name: m[2].trim() });
  }
  // 去掉标记符，同时记录纯文本偏移
  let clean = '';
  let cursor = 0;
  for (const mk of marks) {
    clean += text.slice(cursor, mk.idx);
    const start = clean.length;
    clean += `${mk.name}\n`;
    secs.push({ name: mk.name, level: mk.level, start, end: null, headEnd: clean.length });
    cursor = mk.end;
    if (secs.length > 1) secs[secs.length - 2].end = start - mk.name.length - 1;
  }
  clean += text.slice(cursor);
  if (secs.length) secs[secs.length - 1].end = clean.length;
  if (!secs.length) secs.push({ name: 'Abstract', level: 1, start: 0, end: clean.length, headEnd: 0 });
  return { text: clean.replace(/\n{3,}/g, '\n\n').trim(), sections: secs };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function collectMetadata() {
  const found = new Map();
  for (const { key, q, n } of QUERIES) {
    const cacheFile = path.join(RAW_DIR, `query-${key}.xml`);
    let xml;
    if (OFFLINE && fs.existsSync(cacheFile)) {
      xml = fs.readFileSync(cacheFile, 'utf8');
    } else {
      const url = `${ARXIV_API}?search_query=${encodeURIComponent(q)}&start=0&max_results=${n}&sortBy=relevance`;
      process.stderr.write(`[corpus] query ${key} ...\n`);
      xml = await httpGet(url);
      fs.mkdirSync(RAW_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, xml, 'utf8');
      await sleep(3200); // 遵守 arXiv 建议的请求间隔
    }
    for (const p of parseAtom(xml)) {
      if (!found.has(p.arxiv_id)) found.set(p.arxiv_id, { ...p, query_tags: [key] });
      else found.get(p.arxiv_id).query_tags.push(key);
    }
  }
  return [...found.values()];
}

async function fetchFullText(arxivId) {
  const cacheFile = path.join(RAW_DIR, `html-${arxivId.replace(/[/]/g, '_')}.html`);
  let html;
  if (OFFLINE) {
    if (!fs.existsSync(cacheFile)) return null;
    html = fs.readFileSync(cacheFile, 'utf8');
  } else {
    if (fs.existsSync(cacheFile)) {
      html = fs.readFileSync(cacheFile, 'utf8');
    } else {
      try {
        html = await httpGet(`https://arxiv.org/html/${arxivId}`, { retries: 1, timeoutMs: 90000 });
        fs.mkdirSync(RAW_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, html, 'utf8');
        await sleep(3200);
      } catch {
        fs.writeFileSync(cacheFile, '', 'utf8');
        return null;
      }
    }
  }
  if (!html || html.length < 20000) return null;
  try {
    const text = extractFullText(html);
    return text && text.length > 3000 ? text : null;
  } catch {
    return null;
  }
}

/** 生成文档的权威规范化文本：元数据头 + 正文（或摘要） */
function canonicalText(meta, fullText) {
  const head = [
    `TITLE: ${meta.title}`,
    `AUTHORS: ${meta.authors.slice(0, 12).join(', ')}${meta.authors.length > 12 ? ', et al.' : ''}`,
    `ARXIV: ${meta.arxiv_id}   PUBLISHED: ${meta.published}   CATEGORY: ${meta.primary_category}`,
  ].join('\n');

  if (fullText) {
    return `${head}\n\n${fullText}`;
  }
  return `${head}\n\nAbstract\n${meta.abstract}`;
}

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const metas = await collectMetadata();
  process.stderr.write(`[corpus] metadata: ${metas.length} unique papers\n`);

  const docs = [];
  for (const meta of metas) {
    const fullText = await fetchFullText(meta.arxiv_id);
    const raw = canonicalText(meta, fullText);
    const { text, sections } = splitSections(raw);
    docs.push({
      doc_id: `arxiv:${meta.arxiv_id}`,
      arxiv_id: meta.arxiv_id,
      title: meta.title,
      authors: meta.authors,
      year: meta.year,
      published: meta.published,
      primary_category: meta.primary_category,
      comment: meta.comment,
      abs_url: `https://arxiv.org/abs/${meta.arxiv_id}`,
      html_url: fullText ? `https://arxiv.org/html/${meta.arxiv_id}` : null,
      text_kind: fullText ? 'fulltext' : 'abstract-only',
      text,
      chars: text.length,
      sections,
      query_tags: meta.query_tags,
    });
    process.stderr.write(
      `[corpus]   + ${meta.arxiv_id}  ${fullText ? 'FULL' : 'ABS '}  ${text.length} chars  ${meta.title.slice(0, 60)}\n`,
    );
  }

  docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id));

  const payloadForHash = JSON.stringify(docs.map((d) => [d.doc_id, d.text]));
  const corpus = {
    corpus_id: 'vericite-corpus-v1',
    built_at: new Date().toISOString(),
    domain: 'ai-hallucination / attribution / fact-verification',
    sources: [
      { name: 'arXiv API', url: ARXIV_API },
      { name: 'arXiv HTML full text', url: 'https://arxiv.org/html/{arxiv_id}' },
    ],
    license_note:
      'arXiv 内容遵循各自论文许可（多为 arXiv.org perpetual non-exclusive license 或 CC-BY）。本项目仅用于学术竞赛的非商业演示与研究，未做任何内容改写；原文链接随语料一并保存，可按 doc_id 回溯核查。',
    doc_count: docs.length,
    fulltext_count: docs.filter((d) => d.text_kind === 'fulltext').length,
    total_chars: docs.reduce((s, d) => s + d.chars, 0),
    content_sha256: sha256(payloadForHash),
    docs,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(corpus, null, 1), 'utf8');

  process.stderr.write(
    `\n[corpus] DONE  docs=${corpus.doc_count} fulltext=${corpus.fulltext_count} ` +
      `chars=${corpus.total_chars} sha256=${corpus.content_sha256.slice(0, 16)}...\n`,
  );
  process.stderr.write(`[corpus] written -> ${OUT_FILE}\n`);
}

main().catch((e) => {
  process.stderr.write(`[corpus] FATAL ${e?.stack || e}\n`);
  process.exit(1);
});
