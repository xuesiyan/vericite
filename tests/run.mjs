#!/usr/bin/env node
/**
 * tests/run.mjs — VeriCite 回归测试入口
 *
 * 与 `cli.mjs demo` 共用同一条执行路径（tests/case-runner.mjs），区别只在于：
 *   - 本入口面向机器：只输出结论，任一断言失败即以非零退出码结束，便于 CI 与评委复核；
 *   - `cli.mjs demo` 面向人：逐条打印证据链，并额外导出 evidence/ 运行证据。
 *
 * 用法：
 *   node tests/run.mjs              跑全部样例
 *   node tests/run.mjs normal-01    只跑指定样例（可给多个）
 */
import { loadCorpus } from '../core/corpus.mjs';
import { loadCases, runCase } from './case-runner.mjs';

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const cases = loadCases({ only: wanted.length === 1 ? wanted[0] : null }).filter(
  (c) => wanted.length === 0 || wanted.includes(c.case_id),
);

if (cases.length === 0) {
  console.error('没有匹配的样例');
  process.exit(2);
}

const corpus = loadCorpus();
let passed = 0;
let checks = 0;
let checksPassed = 0;

for (const caseObj of cases) {
  const r = runCase(caseObj, corpus);
  const ok = r.pass;
  const failed = r.checks.filter((c) => !c.ok);
  passed += ok ? 1 : 0;
  checks += r.checks.length;
  checksPassed += r.checks.length - failed.length;

  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${caseObj.category.padEnd(8)} ${caseObj.case_id.padEnd(28)} ` +
      `decision=${r.result.decision}  codes=[${r.result.error_codes.join(', ') || '-'}]`,
  );
  for (const c of failed) console.log(`        x ${c.name} — ${c.detail}`);
}

console.log('');
console.log(`样例 ${passed}/${cases.length}   断言 ${checksPassed}/${checks}   node ${process.version}`);

/* ------------------ 模型通道单元检查（离线：注入假 fetch，不发真实请求） ------------------ */

const { askAgnesVerdicts, isModelChannelAvailable, extractJsonArray } = await import('../core/model-channel.mjs');

const unitChecks = [];
const unit = (name, ok, detail = '') => unitChecks.push({ name, ok, detail });

// 1) 可用性判定：无 Key 关闭、有 Key 打开（不发网络请求）
unit('模型通道：无 AGNES_API_KEY 时不可用', isModelChannelAvailable({}) === false);
unit('模型通道：有 AGNES_API_KEY 时可用', isModelChannelAvailable({ AGNES_API_KEY: 'sk-test' }) === true);

// 2) 未启用时静默降级，绝不发起网络请求
const claims2 = [{ claim_id: 'C001', claim: '测试主张', verdict: 'insufficient' }];
const disabled = await askAgnesVerdicts(claims2, { env: {} });
unit('模型通道：未配置 Key 时返回 DISABLED 且不抛错', disabled.error?.code === 'MODEL_CHANNEL_DISABLED' && disabled.verdicts.length === 0);

// 3) 正常解析：OpenAI 兼容响应 → 结构化判定
const okFetch = async () => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: '前置说明\n[{"claim_id":"C001","verdict":"supported","reason":"证据直接支撑"},{"claim_id":"C002","verdict":"bogus","reason":"x"}]' } }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  }),
});
const okRes = await askAgnesVerdicts(
  [
    { claim_id: 'C001', claim: '主张一', verdict: 'insufficient', primary_evidence: { text: '证据片段……' } },
    { claim_id: 'C002', claim: '主张二', verdict: 'supported', primary_evidence: { text: '证据片段……' } },
  ],
  { env: { AGNES_API_KEY: 'sk-test' }, fetchImpl: okFetch },
);
unit('模型通道：合法判定被映射，非法判定被丢弃',
  okRes.error === null &&
  okRes.verdicts.length === 1 &&
  okRes.verdicts[0].claim_id === 'C001' && okRes.verdicts[0].verdict === 'supported' &&
  okRes.meta.dropped.length === 1 && okRes.meta.dropped[0].reason.startsWith('illegal_verdict'),
  JSON.stringify(okRes.meta?.dropped),
);

// 4) 网关 500 → 降级不抛错
const errFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) });
const errRes = await askAgnesVerdicts(claims2, { env: { AGNES_API_KEY: 'sk-test' }, fetchImpl: errFetch });
unit('模型通道：网关 HTTP 错误时降级留痕', errRes.error?.code === 'MODEL_CHANNEL_HTTP_ERROR' && errRes.verdicts.length === 0);

// 5) 垃圾回复 → 不可解析降级
const junkFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '抱歉，我无法回答。' } }] }) });
const junkRes = await askAgnesVerdicts(claims2, { env: { AGNES_API_KEY: 'sk-test' }, fetchImpl: junkFetch });
unit('模型通道：不可解析回复时降级留痕', junkRes.error?.code === 'MODEL_CHANNEL_UNPARSABLE' && junkRes.verdicts.length === 0);

// 6) JSON 提取器的边界
unit('模型通道：JSON 提取容忍围栏与前后缀',
  JSON.stringify(extractJsonArray('```json\n[{"a":1}]\n```')) === '[{"a":1}]' &&
  extractJsonArray('没有数组') === null,
);

const unitPassed = unitChecks.filter((c) => c.ok).length;
for (const c of unitChecks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  单元      model-channel          ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
}
console.log('');
console.log(`单元  ${unitPassed}/${unitChecks.length}  （模型通道，离线假 fetch）`);

checks += unitChecks.length;
checksPassed += unitPassed;

if (passed !== cases.length || unitPassed !== unitChecks.length) {
  process.exitCode = 1;
}
