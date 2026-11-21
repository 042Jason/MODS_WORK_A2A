// Ensembly (AI 회의실) · Copyright (c) 2026 박재현. All rights reserved. 무단 복제·수정·배포 금지 (LICENSE 참고)
// 설정 화면의 모델 목록. OpenRouter 공개 목록에서 '토론에 쓸 만한' 대화 모델만 추립니다.
// 빼는 것: 지원 종료(예정) 모델, 가격 정보가 없는 모델, 배치·무료·검색·코딩 전용·이미지/음성/영상 모델,
//          문맥이 너무 짧은 모델(자료와 회의록을 다 못 받음), 아주 비싼 모델(출력 100만 토큰당 30달러 초과 — Astra·Fable 급).
// 두 단계로 나눠요. basic: 허용된 회사(ALLOWED_VENDORS)의 최신 12개씩 — 공용 키는 이 중 저렴한 것만.
//               more: 내 키로만 — 허용된 회사는 최신 30개까지, 추가 회사(MORE_VENDORS)도 30개까지. 커뮤니티 파인튜닝·도구 전용 회사는 넣지 않아요.
import { ALLOWED_VENDORS, MORE_VENDORS, PERSONAS, defaultModelOf } from "./_lib/personas.js";

let cache = { at: 0, list: null };
export const VENDOR_LABEL = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", "x-ai": "xAI", upstage: "Upstage",
  deepseek: "DeepSeek", mistralai: "Mistral", qwen: "Qwen (Alibaba)", "meta-llama": "Meta Llama",
  moonshotai: "Moonshot (Kimi)", "z-ai": "Z.ai (GLM)", cohere: "Cohere", amazon: "Amazon Nova",
  minimax: "MiniMax", microsoft: "Microsoft", nvidia: "NVIDIA", baidu: "Baidu (ERNIE)", tencent: "Tencent",
  perplexity: "Perplexity", meta: "Meta", xiaomi: "Xiaomi (MiMo)", "bytedance-seed": "ByteDance Seed", kt: "KT (Mi:dm)",
  stepfun: "StepFun", liquid: "Liquid AI", "ibm-granite": "IBM Granite", writer: "Writer", sakana: "Sakana AI",
  thinkingmachines: "Thinking Machines", nousresearch: "Nous Research", rekaai: "Reka", inclusionai: "inclusionAI (Ant)",
};
const PER_VENDOR = 12;            // basic: 회사마다 최신 모델 몇 개까지
const PER_VENDOR_MORE = 30;       // more(내 키): 회사마다 최신 모델 몇 개까지
const MIN_CONTEXT = 32_000;       // 자료 발췌(최대 3만 6천 자)와 회의록을 함께 받으려면 이 정도는 필요
const MAX_OUT_PRICE = 30;         // 출력 100만 토큰당 달러. 이보다 비싼 Astra·Fable 급은 내 키로도 목록에 넣지 않아요(직접 입력은 가능)
const SKIP = /(:batch|:free|:online|:extended|:exacto|batch|image|imagine|audio|tts|stt|speech|voice|transcri|embed|realtime|search|moderation|guard|safety|deep-?research|codex|coder|code-|-code|\bbuild\b|multi-agent|computer-use|ocr|rerank|vision-preview|instruct-preview)/i;

// 회사 표시 이름: 아는 회사는 위 표, 모르는 회사는 OpenRouter 이름의 앞부분("Perplexity: Sonar Pro" → "Perplexity")
const vendorLabel = (v, name) => VENDOR_LABEL[v] || (String(name || "").includes(":") ? String(name).split(":")[0].trim() : v);

function usable(m) {
  if (SKIP.test(m.id) || SKIP.test(m.name || "")) return false;
  const out = m.architecture?.output_modalities || ["text"], inp = m.architecture?.input_modalities || ["text"];
  if (out.length !== 1 || out[0] !== "text" || !inp.includes("text")) return false;
  if (m.expiration_date) return false;                                   // 지원 종료 예정이거나 이미 종료
  const pin = Number(m.pricing?.prompt), pout = Number(m.pricing?.completion);
  if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0) return false;   // 가격 없음(종료·라우터)
  if (pout * 1e6 > MAX_OUT_PRICE) return false;
  if ((m.context_length || 0) < MIN_CONTEXT) return false;
  return true;
}
const toItem = (m, tier) => ({
  id: m.id,
  name: String(m.name || m.id).replace(/^[^:]+:\s*/, ""),   // "OpenAI: GPT-5 mini" → "GPT-5 mini"
  vendor: vendorLabel(m.id.split("/")[0], m.name),
  context: m.context_length || null,
  priceIn: Number(m.pricing.prompt) * 1e6,
  priceOut: Number(m.pricing.completion) * 1e6,
  created: m.created || 0,
  tier,
});

// vendors: 허용된 회사(순서대로 앞에, 최신 12개는 basic, 그 뒤는 more). moreVendors: 내 키로만 고를 수 있는 추가 회사(모두 more).
export function pickModels(data, vendors, moreVendors = []) {
  const ok = data.filter(usable).sort((a, b) => (b.created || 0) - (a.created || 0));
  const byVendor = {};
  for (const m of ok) {
    const v = m.id.split("/")[0];
    if (!vendors.includes(v) && !moreVendors.includes(v)) continue;
    if ((byVendor[v] ||= []).length < PER_VENDOR_MORE) byVendor[v].push(m);
  }
  return [
    ...vendors.flatMap((v) => (byVendor[v] || []).map((m, i) => toItem(m, i < PER_VENDOR ? "basic" : "more"))),
    ...moreVendors.filter((v) => !vendors.includes(v)).flatMap((v) => (byVendor[v] || []).map((m) => toItem(m, "more"))),
  ];
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
      cache = { at: Date.now(), list: pickModels(data, ALLOWED_VENDORS(), MORE_VENDORS()) };
    } finally { clearTimeout(t); }
  }
  return cache.list;
}
export async function isCheapModel(id) {
  try { const m = (await getCatalog()).find((x) => x.id === id); return !!m && m.tier === "basic" && m.priceOut <= SHARED_MAX_OUT(); }
  catch { return false; }
}

function fallback() {
  const ids = [...new Set(Object.values(PERSONAS).map(defaultModelOf))];
  return ids.map((id) => ({ id, name: id, vendor: VENDOR_LABEL[id.split("/")[0]] || id.split("/")[0], context: null, priceIn: null, priceOut: null, tier: "basic" }));
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
