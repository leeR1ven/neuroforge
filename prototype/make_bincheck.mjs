import fs from "node:fs";
const SRC = "prototype/神经元编辑器原型.html";
const html = fs.readFileSync(SRC, "utf8");
if (!html.includes("</body>")) throw new Error("no </body>");
const TEST = `
<script>
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (name, body) => fetch("/__dump?name=" + name, { method: "POST", body });
  /* NF.compile().bin 给的是 Uint8Array（产物清单统一口径，见 main.js）；老契约是 Blob。
     三种都接住，免得下一回再换类型时，这一页又报「没有 arrayBuffer」看着像编译坏了。 */
  const binU8 = async (b) => (b instanceof Uint8Array) ? b
    : (b instanceof ArrayBuffer) ? new Uint8Array(b)
    : new Uint8Array(await b.arrayBuffer());
  const log = [];
  try {
    await sleep(500);
    /* ---- 确定性伪随机，权重好复现 ---- */
    let seed = 987654321;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
    const mat = (k, n) => { const a = new Float32Array(k * n); for (let i = 0; i < a.length; i++) a[i] = Math.round(rnd() * 2000) / 1000; return a; };

    /* ================= 图 1：带权重块（其中一块跨波次、一块带冻结） ================= */
    NF.clear();
    if (NF.blocksInfo().length !== 0) throw new Error("新建工程没有清掉权重块");
    const ins = [], hid = [], outs = [];
    for (let i = 0; i < 4; i++) ins.push(NF.addNode(i * 3, 0, 0));
    for (let i = 0; i < 4; i++) hid.push(NF.addNode(i * 3, 4, 0));
    for (let i = 0; i < 4; i++) outs.push(NF.addNode(i * 3, 8, 0));
    NF.setIO(ins, 1);
    NF.setIO(outs, 2);
    const blkA = NF.addBlock(ins, hid, mat(4, 4));                       /* 4x4 稠密 */
    const blkB = NF.addBlock(hid, outs, mat(4, 4));                      /* 4x4 稠密 */
    const blkC = NF.addBlock([ins[0], ins[1]], [hid[0], outs[2]], mat(2, 2));  /* 列分属两个波次 */
    const blkD = NF.addBlock([ins[2], ins[3]], [hid[2], hid[3]], mat(2, 2),
                             { lock: Uint8Array.from([1, 0, 0, 1]) });   /* 带冻结掩码 */
    const e0 = NF.addEdge(ins[3], outs[1], 0.4375);                      /* 跳层直连，跟块混着走 */
    const e1 = NF.addEdge(hid[0], outs[3], -0.8125);
    NF.setBias(hid, 0.25);
    NF.setBias(outs, -0.3);
    for (const i of ins) NF.setAct(i, 0);
    for (const i of hid) NF.setAct(i, 1);
    for (const i of outs) NF.setAct(i, 0);
    NF.setLock([ins[0]], 1);
    NF.setEdgeLock([e0], 1);

    const r1 = NF.compile("pytorch", { forceBin: true });
    if (!r1.bin) throw new Error("图1 没有二进制产物 · errors=" + JSON.stringify(r1.errors) + " · warnings=" + JSON.stringify(r1.warnings) + " · N=" + r1.N + " E=" + r1.E + " blocks=" + r1.blocks);
    await post("b1_net.py", r1.code);
    await post("b1_model.bin", await binU8(r1.bin));
    await post("b1_meta.json", JSON.stringify({
      N: r1.N, E: r1.E, waves: r1.waves, blocks: r1.blocks, blockWeights: r1.blockWeights,
      inputs: r1.inputs, outputs: r1.outputs, errors: r1.errors, warnings: r1.warnings,
      blockIds: [blkA, blkB, blkC, blkD],
    }));
    log.push("graph1:N=" + r1.N + "/E=" + r1.E + "/blocks=" + r1.blocks + "/bw=" + r1.blockWeights + "/err=" + r1.errors.length);

    /* ================= 图 2：没有块，只有连接（测 model.bin 的纯边路径） ================= */
    NF.clear();
    if (NF.blocksInfo().length !== 0) throw new Error("新建工程没有清掉权重块（第二张图）");
    if (NF.blockTotal() !== 0) throw new Error("块权重数没有清零");
    const L = [];
    const sizes = [5, 9, 11, 7, 3];
    let y = 0;
    for (let l = 0; l < sizes.length; l++) {
      const row = [];
      for (let i = 0; i < sizes[l]; i++) row.push(NF.addNode(i * 2.5, y, 0));
      L.push(row); y += 4;
    }
    NF.setIO(L[0], 1);
    NF.setIO(L[sizes.length - 1], 2);
    let ne = 0;
    for (let l = 0; l + 1 < sizes.length; l++) {
      for (let i = 0; i < sizes[l]; i++) {
        for (let j = 0; j < sizes[l + 1]; j++) {
          if (((i * 7 + j * 13 + l * 5) % 5) !== 0) continue;   /* 密度约 80% */
          NF.addEdge(L[l][i], L[l + 1][j], Math.round(rnd() * 1500) / 1000);
          ne++;
        }
      }
    }
    for (let l = 0; l < sizes.length; l++) for (const i of L[l]) NF.setAct(i, l === 0 ? 0 : (l % 3 === 1 ? 1 : 2));
    NF.setBias(L[1], 0.15);
    const r2 = NF.compile("pytorch", { forceBin: true });
    if (!r2.bin) throw new Error("图2 没有二进制产物 · errors=" + JSON.stringify(r2.errors) + " · N=" + r2.N + " E=" + r2.E);
    await post("b2_net.py", r2.code);
    await post("b2_model.bin", await binU8(r2.bin));
    await post("b2_meta.json", JSON.stringify({
      N: r2.N, E: r2.E, waves: r2.waves, blocks: r2.blocks, blockWeights: r2.blockWeights,
      inputs: r2.inputs, outputs: r2.outputs, errors: r2.errors, warnings: r2.warnings,
    }));
    log.push("graph2:N=" + r2.N + "/E=" + r2.E + "/edges=" + ne + "/err=" + r2.errors.length);

    const bad = r1.errors.length + r2.errors.length;
    document.title = "NFBIN " + (bad ? "BAD" : "OK") + " " + log.join(" | ");
  } catch (e) {
    document.title = "NFBIN ERR " + String((e && e.stack) || e);
  }
})();
<\/script>
`;
fs.writeFileSync("prototype/_bincheck.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_bincheck.html");
