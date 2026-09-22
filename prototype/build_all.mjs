/* 一条命令的完整构建入口：esbuild 打包 -> 生成成品页 -> 刷新校验页 -> 静态复查。

   B16 之前这两步是分开记在 README 里的，desktop/npm run build 只做「同步 + 打包」，
   少跑 esbuild 或 build.mjs 的话，exe 里装的就是上一版的界面；而 build.mjs 那道
   「bundle 过期」的闸只有显式运行它才生效。现在桌面构建直接调这个入口，
   想打出包就必须先过完整链条。
     node prototype/build_all.mjs          （仓库根或任意目录都行）

   环境变量 NF_ESBUILD 可以指定 esbuild 可执行文件（默认自己到
   prototype/node_modules/@esbuild/ 里找）。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = 'prototype/src/main.js';
const OUTFILE = 'prototype/dist/bundle.js';
const ARGS = ['--bundle', '--format=iife', '--target=chrome110', '--outfile=' + OUTFILE];

function findEsbuild() {
  if (process.env.NF_ESBUILD) return process.env.NF_ESBUILD;
  const base = path.join(REPO_ROOT, 'prototype', 'node_modules', '@esbuild');
  if (!fs.existsSync(base)) return null;
  for (const pkg of fs.readdirSync(base).sort()) {
    for (const rel of [['esbuild.exe'], ['esbuild'], ['bin', 'esbuild']]) {
      const p = path.join(base, pkg, ...rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const esbuild = findEsbuild();
if (!esbuild) {
  console.error('✗ 找不到 esbuild。先在 prototype 里装依赖：cd prototype && npm install');
  console.error('  或者手动指定：set NF_ESBUILD=<路径>');
  process.exit(1);
}

process.chdir(REPO_ROOT);
console.log('· esbuild ' + path.relative(REPO_ROOT, esbuild));
const r = spawnSync(esbuild, [ENTRY, ...ARGS], { cwd: REPO_ROOT, stdio: 'inherit' });
if (r.error) {
  console.error('✗ esbuild 起不来：' + r.error.message);
  process.exit(1);
}
if (r.status !== 0) {
  console.error('✗ esbuild 打包失败（退出码 ' + r.status + '）');
  process.exit(r.status || 1);
}

console.log('· 生成成品页');
await import('./build.mjs');
