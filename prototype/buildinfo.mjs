/* B16：构建指纹 —— 让「打包进 exe 的界面是不是这份源码编出来的」变成可验证的，
   而不是靠 mtime（复制 / 解压 / 改时钟都会骗过时间戳比较）。

   规则只有一条：产物里写死的源码指纹，必须等于「现在这份源码」的指纹。
   源码清单 = prototype/src/*.js（按文件名排序）+ prototype/template.html；
   路径也一起进哈希，所以改名、增删文件都会让指纹变。
   另外还记一份 dist/bundle.js 的哈希：只跑了 esbuild 没跑 build.mjs 时，
   源码指纹照样对不上（产物还是上一版的），一样会被拦下。

   生成侧（build.mjs）写标记，校验侧（desktop/sync_frontend.mjs）读标记，
   两边共用这个文件，免得规则各写一份、改一边忘一边。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MARK = 'NF-BUILD';
export const PROTOTYPE = import.meta.dirname;
export const REPO_ROOT = path.resolve(PROTOTYPE, '..');
export const BUNDLE_REL = path.join('dist', 'bundle.js');

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sourceList(protoDir = PROTOTYPE) {
  const dir = path.join(protoDir, 'src');
  const list = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => path.join('src', f));
  list.push('template.html');
  return list;
}

export function sourceHashes(protoDir = PROTOTYPE) {
  const out = {};
  for (const rel of sourceList(protoDir)) out[rel] = sha256(fs.readFileSync(path.join(protoDir, rel)));
  return out;
}

export function fingerprint(files) {
  const h = crypto.createHash('sha256');
  for (const rel of Object.keys(files).sort()) h.update(rel).update('\0').update(files[rel]).update('\0');
  return h.digest('hex');
}

export function sourceFingerprint(protoDir = PROTOTYPE) {
  return fingerprint(sourceHashes(protoDir));
}

export function buildMarker({ src, bundle, at = new Date().toISOString() }) {
  return '<!-- ' + MARK + ' src=' + src + ' bundle=' + bundle + ' at=' + at + ' -->';
}

export function readMarker(html) {
  const re = new RegExp('<!-- ' + MARK + ' src=([0-9a-f]{64}) bundle=([0-9a-f]{64}) at=(\\S+) -->');
  const m = re.exec(String(html));
  return m ? { src: m[1], bundle: m[2], at: m[3] } : null;
}

/* 比对产物与当前源码。返回 { ok, reason, changed, ... }，changed 是内容变了的源文件。 */
export function verifyArtifact(html, { protoDir = PROTOTYPE, manifest = null } = {}) {
  const mark = readMarker(html);
  if (!mark) return { ok: false, reason: 'no-marker', changed: [] };
  const now = sourceHashes(protoDir);
  const src = fingerprint(now);
  if (mark.src !== src) {
    const old = (manifest && manifest.files) || {};
    const changed = Object.keys(now)
      .filter((k) => old[k] !== now[k])
      .sort();
    return { ok: false, reason: 'stale-source', changed, hasFiles: !!Object.keys(old).length, src, markSrc: mark.src };
  }
  const bundlePath = path.join(protoDir, BUNDLE_REL);
  if (fs.existsSync(bundlePath)) {
    const bundle = sha256(fs.readFileSync(bundlePath));
    if (bundle !== mark.bundle) return { ok: false, reason: 'stale-bundle', changed: [BUNDLE_REL], src, markSrc: mark.src };
  }
  if (manifest && manifest.srcHash && manifest.srcHash !== mark.src) {
    return { ok: false, reason: 'manifest-mismatch', changed: [], src, markSrc: mark.src };
  }
  /* 构建记录里的成品哈希也要对得上：成品页在构建之后被手动改过的话，
     指纹还停在旧源码上，会一路混进 exe。 */
  if (manifest && manifest.artifactHash) {
    const cur = sha256(Buffer.from(String(html), 'utf8'));
    if (cur !== manifest.artifactHash) return { ok: false, reason: 'artifact-tampered', changed: [], src, markSrc: mark.src };
  }
  return { ok: true, reason: 'ok', src, at: mark.at };
}
