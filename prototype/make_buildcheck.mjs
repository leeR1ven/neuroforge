/* 生成 prototype/_buildcheck.html：分片构建一致性校验。
   和 _selftest 的分工：这里只盯"照着渲染器实际拿到的实例缓冲对账"，
   所以能抓到"CPU 数据全对但没挂进场景图 / 层级可见性算错"这类错。 */
import fs from "node:fs";
const SRC = "prototype/\u795e\u7ecf\u5143\u7f16\u8f91\u5668\u539f\u578b.html";
const html = fs.readFileSync(SRC, "utf8");
const TEST = `
<script>
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const out = [];
  const log = (ok, name, detail) => out.push((ok ? "PASS" : "FAIL") + " | " + name + " | " + (detail == null ? "" : detail));
  try {
    if (document.readyState !== "complete") await new Promise(r => addEventListener("load", r));
    await sleep(400);
    const set = (id, v) => { document.getElementById(id).value = v; };
    set("gen-n", 200000); set("gen-l", 150); set("gen-f", 5);
    document.getElementById("gen-go").click();
    await sleep(1500);
    NF.setLod("high");
    for (let i = 0; i < 30; i++) await frame();
    await sleep(2500);
    for (let i = 0; i < 30; i++) await frame();

    const ls = NF.lodState();
    log(ls.builtMask === 7, "\u5206\u7247\u6784\u5efa\u628a\u4e09\u5c42\u90fd\u6807\u4e3a\u5df2\u5efa", "builtMask=" + ls.builtMask);

    const scene = NF.debugScene();
    log(!!scene, "\u8c03\u8bd5\u63a5\u53e3\u53ef\u7528", scene ? Object.keys(scene).join(",") : "missing");
    log(scene.neuronCount === scene.n, "\u795e\u7ecf\u5143\u5b9e\u4f8b\u6570 == \u795e\u7ecf\u5143\u6570", scene.neuronCount + " / " + scene.n);
    log(scene.edgeCount === scene.e, "\u8fde\u7ebf\u5b9e\u4f8b\u6570 == \u8fde\u63a5\u6570", scene.edgeCount + " / " + scene.e);
    log(scene.lineRange === scene.e * 2, "\u7ec6\u7ebf\u5c42 drawRange == 2\u00d7\u8fde\u63a5\u6570", scene.lineRange + " / " + (scene.e * 2));
    log(scene.nBadPos === 0, "\u62bd\u67e5\u795e\u7ecf\u5143\u5b9e\u4f8b\u4f4d\u7f6e\u5168\u90e8\u5bf9\u5f97\u4e0a", scene.nSampled + " \u4e2a\u91cc\u9519 " + scene.nBadPos + " \u4e2a");
    log(scene.nBadScale === 0, "\u62bd\u67e5\u795e\u7ecf\u5143\u5c3a\u5bf8\u5168\u90e8\u5bf9\u5f97\u4e0a", scene.nSampled + " \u4e2a\u91cc\u9519 " + scene.nBadScale + " \u4e2a");
    log(scene.eBadMid === 0, "\u62bd\u67e5\u8fde\u7ebf\u5b9e\u4f8b\u7684\u4f4d\u7f6e == \u4e24\u7aef\u4e2d\u70b9", scene.eSampled + " \u4e2a\u91cc\u9519 " + scene.eBadMid + " \u4e2a");
    log(scene.eBadLen === 0, "\u62bd\u67e5\u8fde\u7ebf\u5b9e\u4f8b\u7684\u957f\u5ea6 == \u4e24\u7aef\u8ddd\u79bb", scene.eSampled + " \u4e2a\u91cc\u9519 " + scene.eBadLen + " \u4e2a");
    log(scene.eBadLine === 0, "\u62bd\u67e5\u7ec6\u7ebf\u7aef\u70b9 == \u8fde\u63a5\u4e24\u7aef\u5750\u6807", scene.eSampled + " \u4e2a\u91cc\u9519 " + scene.eBadLine + " \u4e2a");
    log(scene.eBadColor === 0, "\u62bd\u67e5\u8fde\u7ebf\u989c\u8272\u4e0e\u6743\u91cd\u7b26\u53f7\u4e00\u81f4", scene.eSampled + " \u4e2a\u91cc\u9519 " + scene.eBadColor + " \u4e2a");
    /* \u6269\u5bb9\u540e\u5fd8\u8bb0 scene.add() \u7684\u8bdd\uff0cCPU \u7f13\u51b2\u5168\u5bf9\u4f46\u753b\u9762\u4e0a\u4ec0\u4e48\u90fd\u6ca1\u6709 */
    log(!!(scene.inScene && scene.inScene.n && scene.inScene.e && scene.inScene.line),
        "\u4e09\u4e2a\u5b9e\u4f8b\u7f51\u683c\u90fd\u6302\u5728\u573a\u666f\u56fe\u91cc", JSON.stringify(scene.inScene));
    log(scene.visible.n && scene.visible.e && !scene.visible.line,
        "\u9ad8\u6863\uff1a\u795e\u7ecf\u5143 + \u5706\u67f1\u53ef\u89c1\u3001\u7ec6\u7ebf\u9690\u85cf", JSON.stringify(scene.visible));

    NF.setLod("mid");
    for (let i = 0; i < 8; i++) await frame();
    const s2 = NF.debugScene();
    log(s2.visible.n && !s2.visible.e && s2.visible.line,
        "\u4e2d\u6863\uff1a\u795e\u7ecf\u5143 + \u7ec6\u7ebf\u53ef\u89c1\u3001\u5706\u67f1\u9690\u85cf", JSON.stringify(s2.visible));
    NF.setLod("high");
    for (let i = 0; i < 8; i++) await frame();
    out.push("graph " + JSON.stringify(NF.graph()) + " rebuildMs=" + ls.rebuildMs.toFixed(0));

    const cv = document.getElementById("c");
    for (let k = 0; k < 25; k++) {
      cv.dispatchEvent(new WheelEvent("wheel", { deltaY: 900, bubbles: true, cancelable: true }));
      await frame();
    }
    await sleep(600);
    out.push("lod=" + JSON.stringify(NF.lodState()));
  } catch (e) { out.push("ERROR | " + String((e && e.stack) || e)); }
  const pre = document.createElement("pre");
  pre.id = "nf-buildout";
  pre.textContent = out.join("\\n");
  pre.setAttribute("style", "position:fixed;right:0;top:0;z-index:99999;margin:0;padding:12px;max-width:44%;max-height:100%;overflow:auto;background:#05070c;color:#bff5c8;font:12px/1.5 Consolas,monospace;white-space:pre-wrap");
  document.body.appendChild(pre);
  const pass = out.filter(l => l.indexOf("PASS") === 0).length;
  const fail = out.filter(l => l.indexOf("FAIL") === 0 || l.indexOf("ERROR") === 0).length;
  document.title = "NFBUILD " + pass + "P/" + fail + "F";
})();
<\/script>
`;
fs.writeFileSync("prototype/_buildcheck.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_buildcheck.html");
