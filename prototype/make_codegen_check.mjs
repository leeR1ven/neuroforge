import fs from "node:fs";
const SRC = "prototype/\u795e\u7ecf\u5143\u7f16\u8f91\u5668\u539f\u578b.html";
const html = fs.readFileSync(SRC, "utf8");
if (!html.includes("</body>")) throw new Error("no </body>");
const TEST = `
<script>
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const post = (name, code) => fetch("/__dump?name=" + name, { method: "POST", body: code });
  const put = async (name, text) => {
    const r = await post(name, text);
    if (!r.ok) throw new Error("dump " + name + " -> " + r.status);
  };
  const pick = (art, name) => {
    const f = art.files.find(x => x.name === name);
    if (!f || f.text === undefined) throw new Error("missing artifact " + name +
      " (have: " + art.files.map(x => x.name).join(",") + ")");
    return f.text;
  };
  try {
    await sleep(400);

    /* ---------- 1) demo graph: pytorch target ---------- */
    const r1 = NF.compile("pytorch");
    await put("gen_demo.py", r1.code);
    await put("gen_demo_report.txt", (r1.report || "").slice(0, 8000));

    /* ---------- 2) hand-checkable tiny graph: a->b->c plus a->c ---------- */
    NF.clear();
    const a = NF.addNode(0, 0, 0), b = NF.addNode(0, 0, 0), c = NF.addNode(0, 0, 0);
    NF.setIO([a], 1);
    NF.setIO([c], 2);
    const e0 = NF.addEdge(a, b, 1);
    const e1 = NF.addEdge(b, c, 1);
    const e2 = NF.addEdge(a, c, 1);
    NF.setW(e0, 0.5); NF.setW(e2, 2.0); NF.setW(e1, -1.0);
    NF.setAct(b, 1);   /* relu */
    NF.setAct(c, 0);   /* linear */
    const r2 = NF.compile("pytorch");
    await put("gen_tiny.py", r2.code);
    const artTiny = NF.artifacts("exe");
    if (artTiny.errors.length) throw new Error("exe errors: " + artTiny.errors.join(" | "));
    await put("model_tiny.c", pick(artTiny, "model.c"));
    await put("nforge_build.py", pick(artTiny, "nforge_build.py"));
    await put("build.bat", pick(artTiny, "build.bat"));
    await put("build.sh", pick(artTiny, "build.sh"));
    const artTinyOnnx = NF.artifacts("onnx");
    await put("gen_tiny_onnx.py", pick(artTinyOnnx, "hand_built_net.py"));

    /* ---------- 3) all eight activation functions ---------- */
    NF.clear();
    const ins = [], hid = [], outs = [];
    for (let k = 0; k < 4; k++) ins.push(NF.addNode(0, 0, 0));
    for (let k = 0; k < 8; k++) hid.push(NF.addNode(0, 0, 0));
    for (let k = 0; k < 2; k++) outs.push(NF.addNode(0, 0, 0));
    NF.setIO(ins, 1);
    NF.setIO(outs, 2);
    for (let k = 0; k < 8; k++) NF.setAct(hid[k], k);   /* 0..7 = the whole ACT table */
    for (let k = 0; k < 2; k++) NF.setAct(outs[k], 0);
    let w = 0.0;
    const nw = () => { w = (w + 0.137) % 1.0; return Math.round((w - 0.5) * 1000) / 1000; };
    for (const p of ins) for (const q of hid) NF.addEdge(p, q, nw());
    for (const p of hid) for (const q of outs) NF.addEdge(p, q, nw());
    /* 偏置也给上，别让隐藏层全落在 0 附近看不出激活差别 */
    NF.setBias(hid, 0.25);
    NF.setBias(outs, -0.1);
    const r3 = NF.compile("pytorch");
    if (r3.errors.length) throw new Error("allact pytorch errors: " + r3.errors.join(" | "));
    await put("gen_allact.py", r3.code);
    const artAll = NF.artifacts("exe");
    if (artAll.errors.length) throw new Error("allact exe errors: " + artAll.errors.join(" | "));
    await put("model_allact.c", pick(artAll, "model.c"));

    /* ---------- 4) onnx target: extra helper scripts ---------- */
    const artOnnx = NF.artifacts("onnx");
    await put("onnx_export.bat.txt", pick(artOnnx, "\u5bfc\u51faONNX.bat"));
    await put("onnx_export.sh.txt", pick(artOnnx, "export_onnx.sh"));
    await put("gen_allact_onnx.py", pick(artOnnx, "hand_built_net.py"));

    const sizes = [r1.code.length, r2.code.length, r3.code.length];
    const ok = r1.code.length > 500 && r2.code.length > 200 && r3.code.length > 500 &&
      r2.errors.length === 0 && r3.errors.length === 0 && artTiny.files.length === 4;
    document.title = "NFGEN " + (ok ? "OK" : "BAD") +
      " demo=" + sizes[0] + " tiny=" + sizes[1] + " allact=" + sizes[2] +
      " tinyIn=" + r2.inputs.length + " tinyOut=" + r2.outputs.length + " waves=" + r2.waves +
      " exeFiles=" + artTiny.files.map(f => f.name + ":" + f.text.length).join("/");
  } catch (e) {
    document.title = "NFGEN ERR " + String((e && e.message) || e);
  }
})();
<\/script>
`;
fs.writeFileSync("prototype/_codegen.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_codegen.html (demo + tiny + all-activation + exe + onnx)");