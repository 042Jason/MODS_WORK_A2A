// Ensembly (AI 회의실) · Copyright (c) 2026 박재현. All rights reserved. 무단 복제·수정·배포 금지 (LICENSE 참고)
// 설정 화면의 모델 목록. OpenRouter 공개 목록에서 허용된 회사의 '토론에 쓸 만한' 대화 모델만 추립니다.
// 빼는 것: 지원 종료(예정) 모델, 가격 정보가 없는 모델, 배치·무료·검색·코딩 전용·이미지/음성/영상 모델,
//          문맥이 너무 짧은 모델(자료와 회의록을 다 못 받음), 아주 비싼 모델(출력 100만 토큰당 30달러 초과).
import { ALLOWED_VENDORS, PERSONAS, defaultModelOf } from "./_lib/personas.js";

let cache = { at: 0, list: null };
export const VENDOR_LABEL = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", "x-ai": "xAI", upstage: "Upstage",
  deepseek: "DeepSeek", mistralai: "Mistral", qwen: "Qwen (Alibaba)", "meta-llama": "Meta Llama",
  moonshotai: "Moonshot (Kimi)", "z-ai": "Z.ai (GLM)", cohere: "Cohere", amazon: "Amazon Nova",
  minimax: "MiniMax", microsoft: "Microsoft", nvidia: "NVIDIA", baidu: "Baidu (ERNIE)", tencent: "Tencent",
};
const PER_VENDOR = 12;            // 회사마다 최신 모델 몇 개까지
const MIN_CONTEXT = 32_000;       // 자료 발췌(최대 3만 6천 자)와 회의록을 함께 받으려면 이 정도는 필요
const MAX_OUT_PRICE = 30;         // 출력 100만 토큰당 달러. 이보다 비싼 'pro' 급은 토론용으로 과해요
const SKIP = /(:batch|:free|:online|:extended|:exacto|batch|image|imagine|audio|tts|stt|speech|voice|transcri|embed|realtime|search|moderation|guard|safety|deep-?research|codex|coder|code-|-code|\bbuild\b|multi-agent|computer-use|ocr|rerank|vision-preview|instruct-preview|distill)/i;

export function pickModels(data, vendors, now = Date.now()) {
  const ok = data.filter((m) => {
    if (!vendors.some((v) => m.id.startsWith(`${v}/`))) return false;
    if (SKIP.test(m.id) || SKIP.test(m.name || "")) return false;
    const out = m.architecture?.output_modalities || ["text"], inp = m.architecture?.input_modalities || ["text"];
    if (out.length !== 1 || out[0] !== "text" || !inp.includes("text")) return false;
    if (m.expiration_date) return false;                                   // 지원 종료 예정이거나 이미 종료
    const pin = Number(m.pricing?.prompt), pout = Number(m.pricing?.completion);
    if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0) return false;   // 가격 없음(종료·라우터)
    if (pout * 1e6 > MAX_OUT_PRICE) return false;
    if ((m.context_length || 0) < MIN_CONTEXT) return false;
    return true;
  });
  const byVendor = {};
  for (const m of ok.sort((a, b) => (b.created || 0) - (a.created || 0))) {
    const v = m.id.split("/")[0];
    (byVendor[v] ||= []).length < PER_VENDOR && byVendor[v].push(m);
  }
  return vendors.flatMap((v) => (byVendor[v] || []).map((m) => ({
    id: m.id,
    name: String(m.name || m.id).replace(/^[^:]+:\s*/, ""),   // "OpenAI: GPT-5 mini" → "GPT-5 mini"
    vendor: VENDOR_LABEL[v] || v,
    context: m.context_length || null,
    priceIn: Number(m.pricing.prompt) * 1e6,
    priceOut: Number(m.pricing.completion) * 1e6,
    created: m.created || 0,
  })));
}

// 공용 키로 고를 수 있는 모델: 출력 100만 토큰당 이 가격(달러) 이하
export const SHARED_MAX_OUT = () => Number(process.env.SHARED_MAX_OUT_PRICE) || 5;
// 모델 목록(1시간 캐시). 공용 키로 고른 모델이 저렴한지 서버에서 확인할 때도 써요
export async function getCatalog() {
  if (!cache.list || Date.now() - cache.at > 3600_000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models", { signal: ctrl.signal });
      if (!r.ok) throw new Error(String(r.status));
      const { data } = await r.json();
      cache = { at: Date.now(), list: pickModels(data, ALLOWED_VENDORS()) };
    } finally { clearTimeout(t); }
  }
  return cache.list;
}
export async function isCheapModel(id) {
  try { const m = (await getCatalog()).find((x) => x.id === id); return !!m && m.priceOut <= SHARED_MAX_OUT(); }
  catch { return false; }
}

function fallback() {
  const ids = [...new Set(Object.values(PERSONAS).map(defaultModelOf))];
  return ids.map((id) => ({ id, name: id, vendor: VENDOR_LABEL[id.split("/")[0]] || id.split("/")[0], context: null, priceIn: null, priceOut: null }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=600");
  const vendors = ALLOWED_VENDORS();
  try {
    const models = await getCatalog();
    res.status(200).json({ live: true, vendors, models, sharedMaxOut: SHARED_MAX_OUT() });
  } catch {
    res.status(200).json({ live: false, vendors, models: fallback(), sharedMaxOut: SHARED_MAX_OUT() });
  }
}
