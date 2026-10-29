#!/usr/bin/env node
/**
 * tools/agh-integration.mjs — 在 AGH 本体中装载 VeriCite 插件并执行工具链
 *
 * 为什么需要这个脚本：
 *   赛事要求「AGH 与模型执行闭环」的运行证据。完整的 agent loop 需要 Agnes 模型凭据，
 *   但**插件的装载与工具执行**本身并不需要模型。本脚本复用 AGH 仓库自带的验证方式
 *   （见 agnes-harness/tools/public-docs/examples.test.ts 与 docs/develop/backend.md
 *   的「Verify without a model」一节），用 AGH 自身的代码来验证本项目的插件：
 *
 *     1. AGH 的插件清单解析器        packages/package-manager/src/plugin-manifest.ts
 *     2. AGH 的真实 Cordis 运行时    packages/cordis/src/context.ts（服务注入 + fiber 生命周期）
 *     3. AGH 的工具定义校验器        packages/extension-api/src/tool.ts  (checkToolDef / checkToolMeta)
 *     4. AGH 的参数 schema 校验器    packages/protocol/src/validate.ts   (validateAgainst)
 *
 *   这四者全部来自 AGH 本体，不是本项目自造的替身。因此得到的结论是
 *   「插件在 AGH 的真实装载契约下可用」，而不是「我们自己写了个断言」。
 *
 * 用法：
 *   AGH_REPO=/abs/path/to/agnes-harness  node tools/agh-integration.mjs
 *   （不设 AGH_REPO 时默认取同级目录 ../agnes-harness）
 *
 * 产物：evidence/agh-integration.json、evidence/agh-integration.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const AGH_REPO = path.resolve(process.env.AGH_REPO || path.join(PROJECT_ROOT, '..', 'agnes-harness'));
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'evidence');

if (!fs.existsSync(path.join(AGH_REPO, 'packages', 'cordis', 'src', 'index.ts'))) {
  console.error(`找不到 AGH 仓库：${AGH_REPO}\n请用 AGH_REPO=<agnes-harness 路径> 指定。`);
  process.exit(2);
}

/** AGH 源码里的导入用的是 .js 后缀（TS 项目约定），由 tsx 解析到 .ts，故此处保持一致。 */
const agh = (rel) => pathToFileURL(path.join(AGH_REPO, rel)).href;

/* ------------------------------ 证据账本 ------------------------------ */

const ledger = [];
const checks = [];
let seq = 0;

function emit(stage, action, detail = {}) {
  ledger.push({ seq: ++seq, ts: new Date().toISOString(), stage, action, ...detail });
}

function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  emit(ok ? 'verify' : 'exception', ok ? 'check_passed' : 'check_failed', { check: name, detail });
  return ok;
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  emit('plan', 'integration_start', { agh_repo: AGH_REPO, node: process.version });

  // ---------- 0. 加载 AGH 本体模块 ----------
  const { Context } = await import(agh('packages/cordis/src/index.ts'));
  const { checkToolDef, checkToolMeta } = await import(agh('packages/extension-api/src/index.ts'));
  const { parseAgnesPluginEntries } = await import(agh('packages/package-manager/src/plugin-manifest.ts'));
  const { validateAgainst } = await import(agh('packages/protocol/src/validate.ts'));
  emit('plan', 'agh_modules_loaded', {
    cordis: 'packages/cordis/src/index.ts',
    extension_api: 'packages/extension-api/src/index.ts',
    package_manager: 'packages/package-manager/src/plugin-manifest.ts',
    protocol: 'packages/protocol/src/validate.ts',
  });

  // ---------- 1. 插件清单声明（用 AGH 的解析器读，而不是自己读 JSON） ----------
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const declarations = parseAgnesPluginEntries(pkg.name, pkg.agnes.plugins);
  check('插件清单可被 AGH 解析', declarations.length === 1, `解析出 ${declarations.length} 条声明`);
  const decl = declarations[0];
  check('声明了扩展入口导出名', decl.export === 'vericitePlugin', `export=${decl.export}`);
  check('声明了插件 id', typeof decl.id === 'string' && decl.id.length > 0, `id=${decl.id}`);
  check(
    '声明了 extension 注入依赖',
    Array.isArray(decl.inject) && decl.inject.includes('extension'),
    `inject=${JSON.stringify(decl.inject)}`,
  );
  emit('plan', 'manifest_parsed', { package: pkg.name, declaration: decl });

  // ---------- 2. 载入真实插件模块 ----------
  const mod = await import(pathToFileURL(path.join(PROJECT_ROOT, 'agh-plugin', 'index.mjs')).href);
  const plugin = mod[decl.export];
  check('清单声明的导出在模块中真实存在', typeof plugin?.apply === 'function', `typeof=${typeof plugin?.apply}`);
  check(
    '模块导出与静态声明的注入依赖一致',
    JSON.stringify(plugin.inject) === JSON.stringify(decl.inject),
    `module=${JSON.stringify(plugin.inject)} / manifest=${JSON.stringify(decl.inject)}`,
  );

  // ---------- 3. 用 AGH 的真实 Cordis 运行时装载插件 ----------
  // AGH 的 Host 把插件作为 Cordis 行装载，并向插件提供 `extension()` 服务；插件注册的工具与
  // 监听器随该行的 fiber 一同释放。这里用真实的 Cordis Context 复现同一机制：
  //   provide 服务 → inject 依赖注入 → apply(ctx) → 注册工具/监听 → fiber 释放时自动回收。
  // 捕获到的工具定义随后交给 AGH 自己的 checkToolDef / validateAgainst 校验。
  const mountInto = async (context) => {
    const tools = new Map();
    const hooks = [];
    let ownCtx = null;
    context.provide('extension', () => {
      const own = ownCtx ?? context;
      const silent = () => {};
      return {
        // 与 AGH 的行 API 一致：PluginExtensionAPI.ctx 是 ExtensionContext（不是 Cordis 上下文本身），
        // 因此 log / info / platform / signal 这些字段在这里也照实提供。
        ctx: Object.freeze({
          extId: 'ext:vericite/provenance',
          version: pkg.version ?? '0.0.0',
          trust: 'trusted',
          info: Object.freeze({ id: 'ext:vericite/provenance', version: pkg.version ?? '0.0.0' }),
          platform: Object.freeze({ os: process.platform, arch: process.arch }),
          log: Object.freeze({ debug: silent, info: silent, warn: silent, error: silent }),
          signal: new AbortController().signal,
        }),
        registerTool(def) {
          if (tools.has(def.name)) throw new Error(`工具名重复注册：${def.name}`);
          tools.set(def.name, def);
          const dispose = () => tools.delete(def.name);
          // 与 AGH 行一致：注册随 fiber 生命周期回收（Cordis 的 effect 接收「返回 disposer 的函数」）
          if (typeof own.effect === 'function') own.effect(() => () => dispose());
          return dispose;
        },
        on(event, handler) {
          hooks.push(event);
          return own.on(event, handler);
        },
        registerHook() {
          throw new Error('vericite 是只读工具插件，不应注册 transform/intercept 钩子');
        },
        events: own.events,
      };
    });
    const row = {
      name: 'vericite-provenance-row',
      inject: plugin.inject,
      apply(ctxOfPlugin) {
        ownCtx = ctxOfPlugin;
        return plugin.apply(ctxOfPlugin);
      },
    };
    const f = context.plugin(row);
    await f.await();
    return { fiber: f, tools, hooks };
  };

  const ctx = new Context();
  const first = await mountInto(ctx);
  const registered = first.tools;
  const observedHooks = first.hooks;
  emit('tool_call', 'agh_plugin_mounted', { tools: [...registered.keys()], hooks: observedHooks });
  check('插件在 AGH 的 Cordis 运行时中装载成功', registered.size > 0, `工具数=${registered.size}`);
  check('注册了预期数量的工具', registered.size === 8, `实际 ${registered.size} 个：${[...registered.keys()].join(', ')}`);
  check('注册了 session_start 观察钩子', observedHooks.includes('session_start'), observedHooks.join(', ') || '(none)');
  const firstRunTools = [...registered.keys()].sort();

  // ---------- 4. 用 AGH 的工具定义校验器逐个校验 ----------
  const toolReports = [];
  for (const [name, def] of registered) {
    const verdict = checkToolDef(def, { prefix: '' });
    const metaVerdict = checkToolMeta(def.meta);
    toolReports.push({
      name,
      name_valid: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(def.name),
      description_chars: def.description.length,
      def_ok: verdict.ok,
      def_problems: verdict.ok ? [] : verdict.problems,
      meta_ok: metaVerdict.ok,
      meta_problems: metaVerdict.ok ? [] : metaVerdict.problems,
      meta: def.meta,
    });
    check(`工具定义通过 AGH 校验：${name}`, verdict.ok, verdict.ok ? 'ok' : verdict.problems.join('; '));
    check(`工具元数据通过 AGH 校验：${name}`, metaVerdict.ok, metaVerdict.ok ? 'ok' : metaVerdict.problems.join('; '));
  }

  // ---------- 5. 用 AGH 的参数校验器验证 schema（含反向用例） ----------
  const schemaCases = [
    { tool: 'vericite_search', args: { query: '幻觉 归因' }, expect: true },
    { tool: 'vericite_search', args: {}, expect: false },
    { tool: 'vericite_search', args: { query: 'x', extra: 1 }, expect: false },
    { tool: 'vericite_search', args: { query: 'x'.repeat(2001) }, expect: false },
    { tool: 'vericite_search', args: { query: 42 }, expect: false },
    { tool: 'vericite_verify_claim', args: { claim: 'RAG 能降低幻觉' }, expect: true },
    { tool: 'vericite_verify_claim', args: { claim: 'x', k: 999 }, expect: false },
    { tool: 'vericite_fetch_span', args: { span_id: 'arxiv:2305.00001::100-200' }, expect: true },
    { tool: 'vericite_fetch_span', args: {}, expect: false },
    { tool: 'vericite_audit', args: { text: '测试文本。', k: 8 }, expect: true },
    { tool: 'vericite_audit', args: { text: '测试文本。', model_verdicts: [{ claim_id: 'C001' }] }, expect: false },
    { tool: 'vericite_split_claims', args: { text: '一句话。' }, expect: true },
    { tool: 'vericite_split_claims', args: { text: 1 }, expect: false },
    { tool: 'vericite_error_catalog', args: {}, expect: true },
    { tool: 'vericite_error_catalog', args: { unexpected: true }, expect: false },
  ];
  const schemaReports = [];
  for (const c of schemaCases) {
    const def = registered.get(c.tool);
    const r = validateAgainst(def.parameters, c.args);
    schemaReports.push({ tool: c.tool, args: c.args, expected_valid: c.expect, actual_valid: r.ok });
    check(
      `参数校验（AGH validateAgainst）${c.tool} ${c.expect ? '接受' : '拒绝'} ${JSON.stringify(c.args).slice(0, 60)}`,
      r.ok === c.expect,
      `expected=${c.expect} actual=${r.ok}`,
    );
  }

  // ---------- 6. 在 AGH 装载出来的工具上执行真实工具链 ----------
  const call = async (name, args) => {
    const def = registered.get(name);
    emit('tool_call', name, { args });
    const t0 = Date.now();
    const res = await def.execute(args, {});
    emit('tool_result', `${name}_result`, {
      ms: Date.now() - t0,
      ok: res.structured?.ok ?? null,
      is_error: res.isError === true,
      keys: Object.keys(res.structured || {}),
    });
    return res;
  };

  const chain = [];
  const step = (label, detail) => {
    chain.push(label);
    emit('tool_call', 'chain_step', { step: label, detail });
  };

  const overview = await call('vericite_corpus_overview', {});
  step('vericite_corpus_overview', { corpus_id: overview.structured.corpus_id, span_count: overview.structured.span_count });
  check('语料边界工具返回语料指纹', /^[0-9a-f]{64}$/.test(overview.structured.content_sha256 || ''), overview.structured.content_sha256);

  // 检索式使用英文实词：语料是英文文献，BM25 为词面检索，
  // 跨语言的中→英投影发生在 verify_claim / audit 的核验阶段（见 core/lexicon.mjs 的术语桥）。
  const search = await call('vericite_search', { query: 'retrieval augmented generation hallucination factuality benchmark', k: 6 });
  step('vericite_search', { hits: search.structured.hits.length, quarantined: search.structured.quarantined_spans });
  check('检索步骤返回带 span_id 的候选证据', search.structured.hits.length > 0, `${search.structured.hits.length} 条`);

  const firstSpan = search.structured.hits[0].span_id;
  const span = await call('vericite_fetch_span', { span_id: firstSpan });
  step('vericite_fetch_span', { span_id: firstSpan });
  check('取回的原文与语料切片逐字一致（可回溯）', span.structured.verbatim === span.structured.text, `verbatim_matches=${span.structured.verbatim_matches}`);

  const DRAFT_FAIL = 'LongFact 是一个提示集，包含 2280 条问题，覆盖 83 个主题。';
  const split = await call('vericite_split_claims', { text: DRAFT_FAIL });
  step('vericite_split_claims', { atomic: split.structured.atomic_claims });
  check('规划步骤拆出可核查主张', split.structured.atomic_claims >= 1, `${split.structured.atomic_claims} 条`);

  const verify = await call('vericite_verify_claim', { claim: 'LongFact 包含 2280 条提示，覆盖 38 个人工选定的主题。' });
  step('vericite_verify_claim', { verdict: verify.structured.verdict });
  check('确定性核验给出判定与指标', ['supported', 'insufficient', 'contradicted'].includes(verify.structured.verdict), verify.structured.verdict);

  // 引文真实性：故意给出一条被改写的引文
  const quote = await call('vericite_check_quote', { span_id: firstSpan, quoted_text: '本文证明检索增强生成可以完全消除幻觉。' });
  step('vericite_check_quote', { ok: quote.structured.ok, similarity: quote.structured.similarity });
  check('引文失真被检出', quote.structured.ok === false, `similarity=${quote.structured.similarity}`);

  const audit = await call('vericite_audit', { text: DRAFT_FAIL, k: 8, quotes: [] });
  step('vericite_audit', { decision: audit.structured.decision, codes: audit.structured.error_codes });
  check('无依据的结论被拒绝输出', audit.structured.decision === 'REFUSE', `decision=${audit.structured.decision}`);
  check('拒绝时给出结构化错误码', audit.structured.error_codes.length > 0, audit.structured.error_codes.join(', '));
  check('拒绝时不产生对外结论', audit.structured.output?.kind === 'refusal', `output.kind=${audit.structured.output?.kind}`);

  const catalog = await call('vericite_error_catalog', {});
  step('vericite_error_catalog', { codes: catalog.structured.codes.length });
  check('错误码字典可被查询', catalog.structured.codes.length >= 15, `${catalog.structured.codes.length} 条`);

  // 正常样例：应当放行
  const DRAFT_OK =
    'LongFact 包含 2280 条提示，覆盖 38 个人工选定的主题。' +
    'RAGTruth 是一个大规模幻觉语料库，提供面向 RAG 场景的词级标注。';
  const auditOk = await call('vericite_audit', { text: DRAFT_OK, k: 8 });
  step('vericite_audit_positive', { decision: auditOk.structured.decision, grounding: auditOk.structured.summary?.grounding_rate });
  check(
    '有原文依据的结论被放行且逐条附带引用',
    auditOk.structured.output?.kind === 'verified_summary' &&
      Array.isArray(auditOk.structured.output.citations) &&
      auditOk.structured.output.citations.length > 0,
    `kind=${auditOk.structured.output?.kind} citations=${auditOk.structured.output?.citations?.length}`,
  );

  // ---------- 7. 生命周期：卸载插件 ----------
  await first.fiber.dispose();
  emit('exception', 'agh_plugin_unmounted', { tools_left: registered.size });
  check('卸载后工具随 fiber 一并回收（无残留能力）', registered.size === 0, `剩余 ${registered.size} 个`);

  const second = await mountInto(new Context());
  check('插件可在一个全新的 Cordis 上下文中重新装载', second.tools.size === 8, `二次装载工具数=${second.tools.size}`);
  check(
    '两次装载注册的工具集合完全一致（装载行为可复现）',
    JSON.stringify([...second.tools.keys()].sort()) === JSON.stringify(firstRunTools),
    '第一次与第二次注册的工具名一致',
  );
  await second.fiber.dispose();
  check('二次装载的 fiber 同样能干净卸载', second.tools.size === 0, `剩余 ${second.tools.size} 个`);

  // ---------- 8. 导出证据 ----------
  const passed = checks.filter((c) => c.ok).length;
  const artifact = {
    vericite_version: '1.0.0',
    generated_at: new Date().toISOString(),
    generator: 'node tools/agh-integration.mjs（tsx 运行）',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    agh: {
      repo: AGH_REPO,
      modules_used: [
        'packages/package-manager/src/plugin-manifest.ts (parseAgnesPluginEntries)',
        'packages/cordis/src/index.ts (Context / Fiber 生命周期与依赖注入)',
        'packages/extension-api/src/index.ts (checkToolDef / checkToolMeta)',
        'packages/protocol/src/validate.ts (validateAgainst)',
      ],
      note: '本脚本不连接模型、不启动 daemon，验证的是「插件在 AGH 装载契约下可用」。模型闭环需另配 Agnes 凭据。',
    },
    manifest_declaration: decl,
    tools_registered: [...registered.keys()],
    observed_hooks: observedHooks,
    tool_definitions: toolReports,
    schema_validation: schemaReports,
    tool_call_chain: chain,
    ledger,
    checks,
    summary: { checks_passed: passed, checks_total: checks.length, ledger_entries: ledger.length },
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'agh-integration.json'), JSON.stringify(artifact, null, 2), 'utf8');

  const md = [
    '# AGH 插件装载与工具链执行证据',
    '',
    `- 生成时间：${artifact.generated_at}`,
    `- 运行环境：Node ${process.version} / ${process.platform}-${process.arch}`,
    `- AGH 仓库：\`${AGH_REPO}\``,
    `- 复现命令：\`tsx tools/agh-integration.mjs\`（在 AGH 仓库根目录内执行）`,
    `- 断言：**${passed}/${checks.length}** 通过；事件账本 ${ledger.length} 条`,
    '',
    '## 使用的 AGH 本体模块',
    '',
    ...artifact.agh.modules_used.map((m) => `- \`${m}\``),
    '',
    '## 工具装载结果',
    '',
    '| 工具 | 名称合法 | 描述长度 | 定义校验 | 元数据校验 | 只读 | 需审批 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...toolReports.map(
      (t) =>
        `| \`${t.name}\` | ${t.name_valid ? '✓' : '✗'} | ${t.description_chars} | ${t.def_ok ? '✓' : '✗ ' + t.def_problems.join('; ')} | ${t.meta_ok ? '✓' : '✗ ' + t.meta_problems.join('; ')} | ${t.meta.isReadOnly} | ${t.meta.requiresApproval} |`,
    ),
    '',
    '## 工具调用链',
    '',
    ...chain.map((c, i) => `${i + 1}. \`${c}\``),
    '',
    '## 断言明细',
    '',
    '| 断言 | 结果 | 说明 |',
    '| --- | --- | --- |',
    ...checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${String(c.detail).slice(0, 120)} |`),
    '',
    '## 说明',
    '',
    artifact.agh.note,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'agh-integration.md'), md, 'utf8');

  console.log(`AGH 集成验证：断言 ${passed}/${checks.length} 通过；账本 ${ledger.length} 条`);
  for (const c of checks.filter((x) => !x.ok)) console.log(`  ✗ ${c.name} — ${c.detail}`);
  console.log('证据：evidence/agh-integration.json, evidence/agh-integration.md');
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
