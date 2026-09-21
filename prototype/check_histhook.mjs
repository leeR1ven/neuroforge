/* 静态复查：所有「写连接数据列」的地方，附近有没有对应的登记钩子。

   为什么要有这个：撤销检查点走的是「登记快速路」——没有登记过写入的列整张沿用上一拍，
   一个字节都不比。born-wired-cortex 那种 1681 万条连接的工程上，这一条近路把「稳态拍」从
   225 ms 打到 4 ms；代价是每个写入点都得打一下标记，漏一个 = 那一次改动撤销回不去，
   而且**是静默的**：当场看不出来，几个月后某一次撤销莫名其妙回错一格。
   所以把它变成一次静态检查：漏了就在这里报行号，构建直接失败。

   为什么分三组（拓扑 / 权重 / 选中）：这三类改动的大小差一个数量级。权重列（eW）是调参、
   学习、剪枝归零唯一会碰的列，单独一组之后那种改动只扫 67 MB 而不是 300 MB。

   另一道闸是运行时的裁判（NF.histVerify(true) / 自测里常开）：它不信登记，每一拍整列比一遍，
   抓住「登记说没动、实际动了」就记一次 miss。两道闸互补——静态的查新代码，运行时的查真行为。

   用法：node prototype/check_histhook.mjs    （由 build.mjs 自动跑） */
import fs from 'node:fs';

const SRC = new URL('./src/main.js', import.meta.url);
/* 分组 = 一个「要扫」的登记旗标 + 用这个旗标的列。旗标名必须跟 main.js 里的钩子逐字一致。 */
const GROUPS = [
  { hook: 'histEdgeDirty = 1', cols: ['eSrc', 'eDst', 'eLock', 'eId', 'eHid'] },
  { hook: 'histWDirty = 1', cols: ['eW'] },
  { hook: 'histSelDirty = 1', cols: ['selE'] },
];
const COLS = GROUPS.reduce((a, g) => a.concat(g.cols), []);
const HOOK_OF = {};
for (const g of GROUPS) for (const c of g.cols) HOOK_OF[c] = g.hook;
const BACK = 30;   /* 钩子允许在写入点之前多少行内（要跨过 for / if 那一两层） */
const FWD = 3;     /* ...也允许紧跟在后面几行（写在块尾的情况） */
const lines = fs.readFileSync(SRC, "utf8").split(/\r\n|\n/);
/* 注释里的例子不算代码：块注释要配对跟踪，不然「注释里写了一句 histEdgeDirty = 1;」
   会被当成真钩子，把附近真的漏钩子盖掉。 */
const dead = new Array(lines.length).fill(false);
let inBlock = false;
for (let i = 0; i < lines.length; i++) {
  const t = lines[i];
  const wasBlock = inBlock;
  if (inBlock) { dead[i] = true; if (t.indexOf("*/") >= 0) inBlock = false; }
  const openAt = t.indexOf("/*");
  if (!wasBlock && openAt >= 0) {
    const closeAt = t.indexOf("*/", openAt + 2);
    if (closeAt < 0) { inBlock = true; dead[i] = true; }
  }
  if (!wasBlock && t.trim().indexOf("//") === 0) dead[i] = true;
}

/* 这一行有没有「写」某个列：
     写 = 下标赋值（= += -= *= ...）/ .set( / .fill( / .copyWithin(
   其余一律当读（比较、当参数传、.length、读出来算东西）。 */
function writesOn(line) {
  const hit = [];
  for (const col of COLS) {
    let i = -1;
    while ((i = line.indexOf(col, i + 1)) >= 0) {
      if (i > 0 && /[A-Za-z0-9_$]/.test(line[i - 1])) continue;   /* eSrc2 / XeSrc 不算 */
      let j = i + col.length;
      while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
      if (line[j] === '[') {
        let d = 0, k = j;
        for (; k < line.length; k++) {
          if (line[k] === '[') d++;
          else if (line[k] === ']') { d--; if (!d) { k++; break; } }
        }
        let m = k;
        while (m < line.length && (line[m] === ' ' || line[m] === '\t')) m++;
        if (/^(=|\+=|-=|\*=|\/=|\|=|&=|\^=|<<=|>>=|>>>=)(?!=)/.test(line.slice(m))) hit.push(col);
      } else if (line[j] === '.') {
        const m = /^\.\s*(set|fill|copyWithin)\s*\(/.exec(line.slice(j));
        if (m) hit.push(col + '.' + m[1]);
      }
    }
  }
  return hit;
}
const writers = [];
for (let i = 0; i < lines.length; i++) {
  if (dead[i]) continue;
  const w = writesOn(lines[i]);
  if (w.length) writers.push({ line: i, col: w.join(
), text: lines[i].trim() });
}
/* 一行算不算某个旗标的钩子：出现旗标名、且不是「声明这一行」（let histWDirty = 1; 那种） */
function hasHook(line, hook) {
  if (line.indexOf(hook) < 0) return false;
  if (/^\s*let\s/.test(line)) return false;
  return true;
}
const bad = [];
let far = 0, farLine = 0;
for (const w of writers) {
  /* 一处写入可能涉及多个列：每一列的钩子都得到位（同组共用一个旗标，查的就是同一个字符串） */
  const need = [];
  for (const c of w.col.split(",")) { const h = HOOK_OF[c.split(".")[0]]; if (h && need.indexOf(h) < 0) need.push(h); }
  for (const hook of need) {
    let best = -1;
    for (let j = Math.max(0, w.line - BACK); j <= Math.min(lines.length - 1, w.line + FWD); j++) {
      if (dead[j] || !hasHook(lines[j], hook)) continue;
      const d = Math.abs(j - w.line);
      if (best < 0 || d < best) best = d;
    }
    if (best < 0) { bad.push({ w: w, hook: hook }); break; }
    if (best > far) { far = best; farLine = w.line + 1; }
  }
}

if (bad.length) {
  console.error('✗ 有 ' + bad.length + ' 处写了连接数据列却没有登记钩子：');
  for (const b of bad) console.error("   行 " + (b.w.line + 1) + "  [" + b.w.col + "] 缺 " + b.hook + "  ->  " + b.w.text.slice(0, 100));
  console.error('  这些写入下一次撤销时会丢：补上钩子（写在写入之前，一次调用打一次就够，不要塞进逐边循环里）。');
  process.exit(1);
}
console.log('✓ 连接数据列写入点 ' + writers.length + ' 处（' + COLS.join(' / ') + '），全部带钩子（离得最远的一处：第 ' + farLine + ' 行，隔 ' + far + ' 行）');
