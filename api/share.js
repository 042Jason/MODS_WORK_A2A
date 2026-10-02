// 회의 결과 공유: 결과 페이지(HTML 한 장)를 Vercel Blob에 저장하고 /s/<id> 링크로 보여 줘요.
// 필요한 것: Vercel 프로젝트에 Blob 저장소 연결 (환경변수 BLOB_READ_WRITE_TOKEN이 자동으로 생겨요).
// 공유 페이지는 sandbox로 보여 줘서, 이 사이트에 저장된 키 같은 정보에 접근할 수 없어요.
import crypto from "node:crypto";

const MAX_BYTES = 3 * 1024 * 1024;
const memory = new Map();   // 로컬 개발용 (SHARE_MEMORY=1)
const useBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const useMemory = () => !useBlob() && process.env.SHARE_MEMORY === "1";

const notFound = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>공유된 회의 결과를 찾을 수 없어요</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#333">
<div style="text-align:center"><h1 style="font-size:20px">공유된 회의 결과를 찾을 수 없어요</h1><p>링크가 잘못됐거나 지워졌을 수 있어요.</p></div></body></html>`;

export default async function handler(req, res) {
  if (!useBlob() && !useMemory())
    return res.status(501).json({ error: "not_configured", message: "링크 공유를 쓰려면 Vercel 프로젝트에 Blob 저장소를 연결해 주세요." });

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const html = String(body?.html || "");
    if (!/^<!doctype html>/i.test(html) || Buffer.byteLength(html) > MAX_BYTES) return res.status(400).json({ error: "bad_request" });
    const id = crypto.randomBytes(6).toString("hex");
    if (useMemory()) memory.set(id, html);
    else {
      const { put } = await import("@vercel/blob");
      await put(`shares/${id}.html`, html, { access: "public", contentType: "text/html; charset=utf-8", addRandomSuffix: false });
    }
    return res.status(200).json({ id, path: `/s/${id}` });
  }

  if (req.method === "GET") {
    const id = String(req.query?.id || "");
    let html = null;
    if (/^[a-f0-9]{12}$/.test(id)) {
      if (useMemory()) html = memory.get(id) || null;
      else {
        try {
          const { head } = await import("@vercel/blob");
          const meta = await head(`shares/${id}.html`);
          const r = await fetch(meta.url);
          if (r.ok) html = await r.text();
        } catch { html = null; }
      }
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex");
    // 공유 페이지는 이 사이트와 다른 출처로 취급돼요 (저장된 키·설정에 접근 불가)
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; font-src https: data:; script-src 'unsafe-inline'");
    if (!html) return res.status(404).end(notFound);
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=86400");
    return res.status(200).end(html);
  }
  return res.status(405).json({ error: "method_not_allowed" });
}
