/* B16 回归：桌面打包必须拒绝「不是当前源码编出来的」成品页。
   全离线、全在临时目录里做，不碰真实 desktop/dist，更不碰用户装好的程序。

   手法跟审计的复现一致：搭一个假仓库（prototype/src + template.html + dist/bundle.js），
   再把**没改过的** desktop/sync_frontend.mjs 用 NF_ROOT / NF_ARTIFACT / NF_DIST
   指过去跑，看它收不收旧产物。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildMarker, sourceHashes, fingerprint, sha256 } from './buildinfo.mjs';

const SYNC = fileURLToPath(new URL('../desktop/sync_frontend.mjs', import.meta.url));
const BUILD_ALL = new URL('./build_all.mjs', import.meta.url);
const PKG = new URL('../desktop/package.json', import.meta.url);

let fails = 0;
function check(name, fn) {
  try { fn(); console.log('PASS | ' + name); }
  catch (e) { fails++; console.log('FAIL | ' + name + ' :: ' + ((e && e.message) || e)); }
}

/* 假仓库：prototype/src/*.js + template.html + dist/bundle.js + 一份成品页。
   artifactExtra 模拟「构建完又被人手改过」：构建记录里记的是没改过那份的哈希。 */
function fakeRepo({ withMarker = true, artifactExtra = '', markerFrom = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-b16-'));
  const proto = path.join(root, 'prototype');
  fs.mkdirSync(path.join(proto, 'src'), { recursive: true });
  fs.mkdirSync(path.join(proto, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(proto, 'src', 'main.js'), 'export const NF = 1;\n');
  fs.writeFileSync(path.join(proto, 'src', 'ai_manual.js'), 'export const M = 2;\n');
  fs.writeFileSync(path.join(proto, 'template.html'), '<!DOCTYPE html><html><head>\n<meta charset="UTF-8" />\n</head></html>\n');
  const bundlePath = path.join(proto, 'dist', 'bundle.js');
  fs.writeFileSync(bundlePath, 'window.NF = {};\n');
  const files = sourceHashes(proto);
  const src = fingerprint(files);
  const bundle = sha256(fs.readFileSync(bundlePath));
  const use = markerFrom || { src, bundle };
  const marker = withMarker ? buildMarker({ src: use.src, bundle: use.bundle }) + '\n' : '';
  const clean =
    '<!DOCTYPE html>\n<html lang="zh-CN"><head>\n<meta charset="UTF-8" />\n' + marker +
    '<title>NeuroForge</title></head><body>window.NF = {\nNF3_LAYOUT\n</body></html>\n';
  const disk = artifactExtra ? clean.replace('NF3_LAYOUT', 'NF3_LAYOUT' + artifactExtra) : clean;
  const artifact = path.join(proto, '神经元编辑器原型.html');
  fs.writeFileSync(artifact, disk);
  fs.writeFileSync(
    path.join(proto, 'dist', 'build-manifest.json'),
    JSON.stringify({ at: new Date().toISOString(), srcHash: src, bundleHash: bundle, artifactHash: sha256(Buffer.from(clean, 'utf8')), files }, null, 2),
  );
  return { root, proto, artifact, dist: path.join(root, 'desktop', 'dist', 'index.html'), src, bundle, files };
}

function runSync(repo) {
  return spawnSync(process.execPath, [SYNC], {
    encoding: 'utf8',
    env: { ...process.env, NF_ROOT: repo.root, NF_ARTIFACT: repo.artifact, NF_DIST: repo.dist },
  });
}

function withRepo(opts, fn) {
  const repo = fakeRepo(opts);
  try { return fn(repo); } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
}

check('一份对得上源码的成品页：通过，并真的落到 dist', () => {
  withRepo({}, (repo) => {
    const r = runSync(repo);
    assert.equal(r.status, 0, '本该通过，却退出 ' + r.status + '：' + r.stderr);
    assert.ok(fs.existsSync(repo.dist), 'dist/index.html 没写出来');
    const rec = JSON.parse(fs.readFileSync(path.join(path.dirname(repo.dist), 'build-manifest.json'), 'utf8'));
    assert.equal(rec.srcHash, repo.src, '构建记录里的源码指纹不对');
    assert.equal(rec.frontendHash, sha256(fs.readFileSync(repo.dist)), '记录的前端哈希与落盘的不一致');
  });
});

check('审计的复现：只有三个标记、没有指纹的旧 HTML（mtime 2020 + 更新的 main.js）被拒', () => {
  withRepo({ withMarker: false }, (repo) => {
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(repo.artifact, old, old);
    fs.writeFileSync(path.join(repo.proto, 'src', 'main.js'), 'export const NF = 2;\n');
    const r = runSync(repo);
    assert.notEqual(r.status, 0, '旧产物居然被放行了');
    assert.match(r.stderr, /指纹|旧产物/, '报错里没说清是旧产物：' + r.stderr);
    assert.ok(!fs.existsSync(repo.dist), '被拒了却还是写了 dist');
  });
});

check('成品页生成后又改了源码：拒绝，并指名改的是哪个文件', () => {
  withRepo({}, (repo) => {
    fs.writeFileSync(path.join(repo.proto, 'src', 'ai_manual.js'), 'export const M = 3;\n');
    fs.utimesSync(repo.artifact, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    const r = runSync(repo);
    assert.notEqual(r.status, 0, '源码改过还放行');
    assert.match(r.stderr, /src[\/\\]ai_manual\.js/, '没指名改过的文件：' + r.stderr);
    assert.ok(!fs.existsSync(repo.dist), '被拒了却还是写了 dist');
  });
});

check('只跑了 esbuild、没跑 build.mjs：bundle 对不上也要拒', () => {
  withRepo({}, (repo) => {
    fs.writeFileSync(path.join(repo.proto, 'dist', 'bundle.js'), 'window.NF = { v: 2 };\n');
    const r = runSync(repo);
    assert.notEqual(r.status, 0, 'bundle 变了还放行');
    assert.match(r.stderr, /bundle/, '报错里没提 bundle：' + r.stderr);
  });
});

check('成品页构建后被手改过：哈希对不上构建记录，拒', () => {
  withRepo({ artifactExtra: '<p>手改</p>' }, (repo) => {
    const r = runSync(repo);
    assert.notEqual(r.status, 0, '被改过的成品页还放行');
    assert.match(r.stderr, /改过|对不上/, '报错没说清：' + r.stderr);
  });
});

check('源码里加了新文件（新模块）：指纹跟着变，旧产物被拒', () => {
  withRepo({}, (repo) => {
    fs.writeFileSync(path.join(repo.proto, 'src', 'brand_new.js'), 'export const X = 1;\n');
    const r = runSync(repo);
    assert.notEqual(r.status, 0, '新模块没进指纹');
  });
});

check('完整构建入口存在，且按 esbuild -> build.mjs 的顺序跑', () => {
  const src = fs.readFileSync(BUILD_ALL, 'utf8');
  assert.match(src, /--bundle/);
  assert.match(src, /--outfile/);
  assert.match(src, /@esbuild/);
  assert.match(src, /await import\('\.\/build\.mjs'\)/, '没接上 build.mjs');
  assert.ok(src.indexOf('--outfile') < src.indexOf("await import('./build.mjs')"), '顺序反了');
});

check('desktop 的 build / check 都先跑完整前端构建', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  assert.match(pkg.scripts.frontend || '', /build_all\.mjs/, 'frontend 脚本没指向完整入口');
  for (const s of ['build', 'check']) {
    const v = pkg.scripts[s] || '';
    assert.ok(v.indexOf('npm run frontend') >= 0, s + ' 没先构建前端：' + v);
    assert.ok(v.indexOf('npm run frontend') < v.indexOf('sync_frontend.mjs'), s + ' 顺序不对：' + v);
  }
});

check('仓库里那份真成品页带着指纹、且与当前源码对得上', () => {
  const real = fileURLToPath(new URL('./神经元编辑器原型.html', import.meta.url));
  if (!fs.existsSync(real)) return;
  const html = fs.readFileSync(real, 'utf8');
  const mark = /<!-- NF-BUILD src=([0-9a-f]{64})/.exec(html);
  assert.ok(mark, '真成品页里没有指纹 —— 跑一遍 node prototype/build_all.mjs 重新生成');
  const proto = fileURLToPath(new URL('./', import.meta.url));
  assert.equal(mark[1], fingerprint(sourceHashes(proto)), '真成品页是旧源码编的 —— 跑一遍 node prototype/build_all.mjs');
});

console.log(fails ? 'B16 BUILD CHECKS: ' + fails + ' failed' : 'B16 BUILD CHECKS: all passed');
process.exit(fails ? 1 : 0);
