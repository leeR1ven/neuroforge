/* 把「成品单文件 HTML」同步成桌面壳的前端：desktop/dist/index.html
   成品页是 prototype/build.mjs 生成的，这里只做搬运 + 一句存在性检查，
   免得打包进 exe 的是一份过期的界面。 */
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const root = path.resolve(here, '..');
const src = path.join(root, 'prototype', '神经元编辑器原型.html');
const dst = path.join(here, 'dist', 'index.html');

if (!fs.existsSync(src)) throw new Error('找不到成品页：' + src + '（先在根目录跑 node prototype/build.mjs）');
const html = fs.readFileSync(src, 'utf8');
for (const must of ['window.NF = {', 'NF3_LAYOUT', '</html>']) {
  if (!html.includes(must)) throw new Error('成品页里没有 ' + must + '，像是打包坏了');
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, html);
const size = (fs.statSync(dst).size / 1048576).toFixed(2);
console.log('已同步前端: dist/index.html  ' + size + ' MB');
