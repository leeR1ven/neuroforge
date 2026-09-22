import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/* 一条命令完整构建：先把 src 打出来的 bundle 塞进模板生成单文件原型，
   再顺手把 17 个衍生的校验页一起刷新。

   为什么要把 make_* 收进来：那些页面是从这里生成的单文件原型里切的，
   以前得记住「先 build 再逐个跑 make_*」，谁少跑一步，就会拿着上一版的原型去自测，
   表现是「代码改了，自测结果跟上次一模一样」——这一轮真踩过：
   自测报的两个 FAIL 全是旧代码留下的，白查了半天。 */
/* 这道闸是拿血换的：**esbuild 不在这里跑**，得先在仓库根跑
     prototype\\node_modules\\@esbuild\\win32-x64\\esbuild.exe prototype\\src\\main.js --bundle ...
   少跑那一步的话，这个脚本会把上一次的 bundle 塞进成品页 —— 于是「代码改了、自测/桌面版还是
   旧行为」。2026-09 真踩过：连着四轮改动没进包，桌面版实测数字全是旧的，白查了两个小时。
   所以这里先比时间戳：源码比 bundle 新就当场报错，别让它静默出一个过期成品。 */
{
  const srcDir = 'prototype/src';
  const bundle = 'prototype/dist/bundle.js';
  const bt = fs.statSync(bundle).mtimeMs;
  let newest = '', nt = 0;
  for (const f of fs.readdirSync(srcDir)) {
    const p = srcDir + '/' + f;
    if (!fs.statSync(p).isFile()) continue;
    const m = fs.statSync(p).mtimeMs;
    if (m > nt) { nt = m; newest = p; }
  }
  if (nt > bt) {
    console.error('✗ bundle 过期了：' + newest + ' 比 ' + bundle + ' 新。');
    console.error('  先在仓库根跑一遍 esbuild 再 build：');
    console.error('    .\\prototype\\node_modules\\@esbuild\\win32-x64\\esbuild.exe prototype\\src\\main.js --bundle --format=iife --target=chrome110 --outfile=prototype\\dist\\bundle.js');
    process.exit(2);
  }
}

const html = fs.readFileSync('prototype/template.html', 'utf8');
let js = fs.readFileSync('prototype/dist/bundle.js', 'utf8');
js = js.replace(/<\/script/gi, '<\\/script');
const out = html.replace('<script src="./dist/bundle.js"></script>', '<script>\n' + js + '\n</script>');
if (out === html) throw new Error('未找到打包脚本占位符');
fs.writeFileSync('prototype/神经元编辑器原型.html', out);
fs.writeFileSync('prototype/index.html', out);
console.log('已生成单文件原型: ' + (Buffer.byteLength(out) / 1024 / 1024).toFixed(2) + ' MB');

const mk = fs.readdirSync('prototype').filter((f) => /^make_.*\.mjs$/.test(f)).sort();
for (const f of mk) {
  const r = spawnSync(process.execPath, ['prototype/' + f], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('生成失败：' + f); process.exit(r.status || 1); }
}
console.log('衍生的校验页已全部刷新（' + mk.length + ' 个）');

/* 静态复查：不是生成页面，而是「改错了会当场报」的守卫（见 check_histhook.mjs）。
   放在最后跑：它查的是刚写进 bundle 的那份源码。 */
const ck = fs.readdirSync('prototype').filter((f) => /^check_.*\.mjs$/.test(f)).sort();
for (const f of ck) {
  const r = spawnSync(process.execPath, ['prototype/' + f], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('静态复查没通过：' + f); process.exit(r.status || 1); }
}
console.log('静态复查已通过（' + ck.length + ' 个）');
