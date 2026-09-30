// 로컬 실행용 서버: Vercel 없이 `node dev-server.mjs` 로 똑같이 돌려 볼 수 있습니다.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

// .env 읽기
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
const handlers = {
  a2a: (await import(pathToFileURL(path.join(ROOT, "api/a2a.js")))).default,
  registry: (await import(pathToFileURL(path.join(ROOT, "api/registry.js")))).default,
  models: (await import(pathToFileURL(path.join(ROOT, "api/models.js")))).default,
};

function wrapRes(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(o)); return res; };
  return res;
}

http.createServer(async (req, rawRes) => {
  const res = wrapRes(rawRes);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams);
  let fn = null;
  let m;
  if ((m = url.pathname.match(/^\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/))) { fn = "a2a"; query.agent = m[1]; query.card = "1"; }
  else if ((m = url.pathname.match(/^\/agents\/([^/]+)\/?$/))) { fn = "a2a"; query.agent = m[1]; }
  else if (url.pathname === "/api/registry") fn = "registry";
  else if (url.pathname === "/api/models") fn = "models";
  else if (url.pathname === "/api/a2a") fn = "a2a";

  if (fn) {
    let body = "";
    for await (const chunk of req) body += chunk;
    req.query = query;
    try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = body; }
    try { await handlers[fn](req, res); }
    catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
    return;
  }
  const file = path.join(ROOT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.status(404).end("not found");
  res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`회의실: http://localhost:${PORT}  (서버 키 ${process.env.OPENROUTER_API_KEY ? "있음" : "없음 → 웹에서 키를 넣거나 모의 모드"})`);
});
