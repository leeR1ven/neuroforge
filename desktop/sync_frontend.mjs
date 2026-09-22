/* 把「成品单文件 HTML」同步成桌面壳的前端：desktop/dist/index.html
   成品页是 prototype/build.mjs 生成的，这里搬到壳子里 —— 但不再只是「看一眼字符串在不在」。

   B16 之前只看三个字符串，于是「源码改了、成品还是上一版」照样能打进 exe；
   现在成品页里带着构建指纹（见 prototype/buildinfo.mjs），这里逐文件核对源码哈希，
   对不上就直接拒绝，并指名是哪个文件变了。想通过就得先跑完整构建（npm run frontend）。

   环境变量只给回归测试用，正常构建不要设：
     NF_ROOT      仓库根（默认 desktop 的上一级）
     NF_ARTIFACT  成品页（默认 <root>/prototype/神经元编辑器原型.html）
     NF_DIST      目标（默认 desktop/dist/index.html） */
import fs from 'node:fs';
import path from 'node:path';
import { verifyArtifact, sha256 } from '../prototype/buildinfo.mjs';

const here = import.meta.dirname;
const root = process.env.NF_ROOT ? path.resolve(process.env.NF_ROOT) : path.resolve(here, '..');
const protoDir = path.join(root, 'prototype');
const src = process.env.NF_ARTIFACT ? path.resolve(process.env.NF_ARTIFACT) : path.join(protoDir, '神经元编辑器原型.html');
const dst = process.env.NF_DIST ? path.resolve(process.env.NF_DIST) : path.join(here, 'dist', 'index.html');
const record = path.join(path.dirname(dst), 'build-manifest.json');
const buildManifestPath = path.join(protoDir, 'dist', 'build-manifest.json');

if (!fs.existsSync(src)) {
  throw new Error('找不到成品页：' + src + '\n  先在仓库根跑 node prototype/build_all.mjs（或 cd desktop && npm run frontend）');
}
const html = fs.readFileSync(src, 'utf8');
for (const must of ['window.NF = {', 'NF3_LAYOUT', '</html>']) {
  if (!html.includes(must)) throw new Error('成品页里没有 ' + must + '，像是打包坏了');
}

const buildManifest = fs.existsSync(buildManifestPath) ? JSON.parse(fs.readFileSync(buildManifestPath, 'utf8')) : null;
const verdict = verifyArtifact(html, { protoDir: protoDir, manifest: buildManifest });
if (!verdict.ok) {
  console.error('✗ 拒绝打包：这份成品页不是当前源码编出来的。');
  if (verdict.reason === 'no-marker') console.error('  成品页里没有构建指纹，是 B16 之前的旧产物。');
  else if (verdict.reason === 'stale-bundle') console.error('  源码没变但 bundle 变了：跑过 esbuild、没跑全量构建。');
  else if (verdict.reason === 'stale-source') console.error('  这些源码在成品页生成之后又被改过：');
  else if (verdict.reason === 'artifact-tampered') console.error('  成品页在构建之后被改过（哈希对不上构建记录）。');
  else console.error('  构建记录与成品页对不上（构建记录被换过？）。');
  if (verdict.changed && verdict.changed.length) {
    for (const f of verdict.changed) console.error('    prototype/' + f.split(path.sep).join('/'));
  } else if (verdict.reason === 'stale-source') {
    console.error('    （没有逐文件记录可对比，整份重建一次即可）');
  }
  console.error('  正确做法：cd desktop && npm run build（会先跑前端的完整构建再打包）');
  process.exit(1);
}

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, html);
const distBuf = fs.readFileSync(dst);
const size = (distBuf.length / 1048576).toFixed(2);
console.log('已同步前端: dist/index.html  ' + size + ' MB');
console.log('源码指纹 ' + verdict.src.slice(0, 12) + '…（来自 ' + (verdict.at || '未知时间') + ' 的构建，已核对）');
fs.writeFileSync(
  record,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      builtAt: verdict.at || null,
      srcHash: verdict.src,
      bundleHash: (buildManifest && buildManifest.bundleHash) || null,
      artifact: path.relative(root, src).split(path.sep).join('/'),
      artifactHash: sha256(Buffer.from(html, 'utf8')),
      frontend: path.relative(root, dst).split(path.sep).join('/'),
      frontendHash: sha256(distBuf),
      frontendBytes: distBuf.length,
      files: (buildManifest && buildManifest.files) || null,
    },
    null,
    2,
  ) + '\n',
);
console.log('构建记录: ' + path.relative(root, record).split(path.sep).join('/'));
