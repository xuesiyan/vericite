#!/usr/bin/env node
/**
 * tools/run-agh-integration.mjs — AGH 集成验证的跨平台启动器
 *
 * tools/agh-integration.mjs 需要导入 AGH 仓库里的 TypeScript 源码，
 * 因此必须由 tsx 执行，而不能直接用 node 跑。而 tsx 装在 AGH 仓库的 node_modules 里。
 *
 * 本启动器负责：定位 AGH 仓库 → 找到它的 tsx → 以正确的工作目录和环境变量启动验证脚本。
 * 这样复现命令就只剩一条：node tools/run-agh-integration.mjs
 *
 * 可用环境变量：
 *   AGH_REPO        AGH 仓库路径（默认 ../agnes-harness）
 *   AGH_NODE        Node 可执行文件（默认当前进程所用的 node；AGH 要求 Node ≥ 24.10）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const AGH_REPO = path.resolve(process.env.AGH_REPO || path.join(PROJECT_ROOT, '..', 'agnes-harness'));

const fail = (msg) => {
  console.error(msg);
  process.exit(2);
};

if (!fs.existsSync(path.join(AGH_REPO, 'packages', 'cordis', 'src', 'index.ts'))) {
  fail(
    `找不到 AGH 仓库：${AGH_REPO}\n` +
      '请先克隆 Agnes Harness，或用 AGH_REPO=<路径> 指定位置：\n' +
      '  git clone https://github.com/AgnesAI-Labs/agnes-harness.git\n',
  );
}

/** 在 AGH 仓库里找 tsx：先看本地 node_modules，再看 .pnpm 的虚拟目录。 */
function findTsx(repo) {
  const candidates = [
    path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(repo, 'node_modules', '.bin', 'tsx.cmd'),
    path.join(repo, 'node_modules', '.bin', 'tsx'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;

  const pnpmDir = path.join(repo, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    const hit = fs
      .readdirSync(pnpmDir)
      .filter((d) => d.startsWith('tsx@'))
      .sort()
      .reverse()
      .map((d) => path.join(pnpmDir, d, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
      .find((p) => fs.existsSync(p));
    if (hit) return hit;
  }
  return null;
}

const tsx = findTsx(AGH_REPO);
if (!tsx) {
  fail(
    `在 AGH 仓库里找不到 tsx：${AGH_REPO}\n` +
      '请先在 AGH 仓库根目录执行依赖安装：\n' +
      '  corepack pnpm install\n',
  );
}

const target = path.join(PROJECT_ROOT, 'tools', 'agh-integration.mjs');
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.warn(
    `[warn] 当前 Node 为 v${process.versions.node}，AGH 要求 Node ≥ 24.10。\n` +
      '        如验证失败，请用 Node 24 重跑，或设置 AGH_NODE 指向 Node 24 的可执行文件。\n',
  );
}

// realpath：让 AGH 源码里的 `@agnes/*` 从 AGH 自己的 node_modules 解析
const realTsx = fs.realpathSync(tsx);
console.log(`[agh] repo  = ${AGH_REPO}`);
console.log(`[agh] tsx   = ${realTsx}`);
console.log(`[agh] node  = ${process.version}`);
console.log(`[agh] target= ${target}\n`);

const r = spawnSync(process.execPath, [realTsx, target], {
  cwd: AGH_REPO,
  stdio: 'inherit',
  env: { ...process.env, AGH_REPO },
});
process.exit(r.status ?? 1);
