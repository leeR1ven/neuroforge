import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve("prototype");
const outDir = path.resolve("_dump");
fs.mkdirSync(outDir, { recursive: true });
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (req.method === "POST" && u.pathname === "/__dump") {
    const name = path.basename(u.searchParams.get("name") || "out.txt");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      fs.writeFileSync(path.join(outDir, name), Buffer.concat(chunks));
      res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      res.end("saved " + name);
      console.log("dumped", name, Buffer.concat(chunks).length, "bytes");
    });
    return;
  }
  /* 页面没放 favicon，浏览器照样会来要一次；直接 204，别在控制台刷 404 */
  if (u.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  let p = decodeURIComponent(u.pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end("404"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(8731, "127.0.0.1", () => console.log("serving on 8731"));
