// 설정 화면의 모델 목록. OpenRouter 공개 목록에서 허용된 회사(기본: OpenAI, Anthropic, Google, xAI, Upstage)만 추립니다.
import { ALLOWED_VENDORS, PERSONAS, defaultModelOf } from "./_lib/personas.js";

let cache = { at: 0, list: null };
const VENDOR_LABEL = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", "x-ai": "xAI", upstage: "Upstage" };

function fallback() {
  const ids = [...new Set(Object.values(PERSONAS).map(defaultModelOf))];
  return ids.map((id) => ({ id, name: id, vendor: VENDOR_LABEL[id.split("/")[0]] || id.split("/")[0], context: null, priceIn: null, priceOut: null }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=600");
  const vendors = ALLOWED_VENDORS();
  try {
    if (!cache.list || Date.now() - cache.at > 3600_000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch("https://openrouter.ai/api/v1/models", { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(String(r.status));
      const { data } = await r.json();
      cache = {
        at: Date.now(),
        list: data
          .filter((m) => vendors.some((v) => m.id.startsWith(`${v}/`)))
          .filter((m) => (m.architecture?.output_modalities || ["text"]).includes("text"))
          .filter((m) => !/(image|audio|tts|stt|embed|realtime|search|moderation)/i.test(m.id))
          .map((m) => ({
            id: m.id,
            name: m.name,
            vendor: VENDOR_LABEL[m.id.split("/")[0]] || m.id.split("/")[0],
            context: m.context_length || null,
            priceIn: m.pricing?.prompt ? Number(m.pricing.prompt) * 1e6 : null,
            priceOut: m.pricing?.completion ? Number(m.pricing.completion) * 1e6 : null,
            created: m.created || 0,
          }))
          .sort((a, b) => a.vendor.localeCompare(b.vendor) || b.created - a.created),
      };
    }
    res.status(200).json({ live: true, vendors, models: cache.list });
  } catch {
    res.status(200).json({ live: false, vendors, models: fallback() });
  }
}
