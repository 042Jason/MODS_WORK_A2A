// Ensembly (AI 회의실) · Copyright (c) 2026 박재현. All rights reserved. 무단 복제·수정·배포 금지 (LICENSE 참고)
// OpenRouter 호출. 키는 (1) 브라우저에서 보낸 사용자 키 → (2) 인증된 사람에게만 서버 공용 키 순서로 씁니다.
// 둘 다 안 되면 모의 모드(mock.js)로 답합니다.

export function resolveKey(userKey, serverAllowed) {
  if (process.env.MOCK_LLM === "1") return null;
  if (userKey) return userKey;
  if (serverAllowed && process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  return null;
}

export function parseJSON(text) {
  if (!text) throw new Error("모델 응답이 비어 있어요.");
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`JSON을 찾지 못했어요: ${cleaned.slice(0, 120)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

// 같은 에이전트가 같은 자료를 매번 다시 읽으니, 앞부분(주제·자료)을 캐시해 두면 다시 읽을 때 싸고 빨라요.
// GPT·Gemini·DeepSeek·Grok 계열은 앞부분이 같으면 자동으로 캐시돼요. Claude는 표시(cache_control)를 붙여야 해요.
function userContent(model, user, cachePrefixLen) {
  if (!/^anthropic\//.test(model) || !cachePrefixLen || cachePrefixLen < 4000 || cachePrefixLen >= user.length) return user;
  return [
    { type: "text", text: user.slice(0, cachePrefixLen), cache_control: { type: "ephemeral" } },
    { type: "text", text: user.slice(cachePrefixLen) },
  ];
}

async function callOnce({ apiKey, model, system, user, temperature, maxTokens, jsonMode, lightReasoning, cachePrefixLen = 0, onUsage, timeoutMs = 50_000 }) {
  const ctrl = new AbortController();
  const limit = Math.max(3000, timeoutMs);
  const timer = setTimeout(() => ctrl.abort(), limit);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.PUBLIC_URL || "https://a2a-meeting-room.vercel.app",
        "X-Title": "A2A Meeting Room",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent(model, user, cachePrefixLen) },
        ],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        // 추론 모델이 생각하느라 시간을 다 쓰지 않도록 가볍게, 추론 내용은 받지 않음
        ...(lightReasoning ? { reasoning: { effort: "low", exclude: true } } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message || msg; } catch {}
      const err = new Error(`OpenRouter ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(text);
    // 회의 품질 점수표의 '비용' 칸에 쓸 실제 토큰 수
    if (data.usage) onUsage?.({ in: Number(data.usage.prompt_tokens) || 0, out: Number(data.usage.completion_tokens) || 0, cost: Number(data.usage.cost) || 0 });
    return data.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    if (e.name === "AbortError") { const err = new Error(`모델 응답이 ${Math.round(limit / 1000)}초 안에 오지 않았어요.`); err.status = 408; throw err; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── 모델 폴백 ─────────────────────────────────────────────────────────
// 고른 모델이 응답하지 않거나(시간 초과·서버 오류·과부하·빈 답·JSON 깨짐·지원 종료) 실패하면 다음 모델로 넘어가요.
// 키가 틀렸거나(401) 잔액이 없을 때(402)는 다른 모델로 바꿔도 같으니 바로 알려 줘요.
const fatal = (e) => e?.status === 401 || e?.status === 402;
// 최근에 실패한 모델은 5분 동안 뒤로 미뤄요 (같은 서버 인스턴스가 살아 있는 동안)
const sick = new Map();
const SICK_MS = 5 * 60_000;
export const isSick = (m) => (sick.get(m) || 0) > Date.now();

// model을 먼저 부르고, 실패하면 fallbacks를 차례로 불러요. 실제로 쓴 모델은 onModel, 대신 불렀으면 onFallback으로 알려 줘요.
// 서버 함수 제한 시간(60초) 안에 끝나도록 전체 예산을 나눠 써요: 뒤에 대체 모델이 남아 있으면 한 모델에 최대 25초.
export async function chatJSON({ apiKey, model, fallbacks = [], onModel, onFallback, budgetMs = 52_000, ...rest }) {
  const end = Date.now() + budgetMs;
  const all = [model, ...fallbacks].filter((m, i, a) => m && a.indexOf(m) === i);
  const chain = [...all.filter((m) => !isSick(m)), ...all.filter((m) => isSick(m))];
  let lastErr, firstErr;
  for (const [k, m] of chain.entries()) {
    const left = end - Date.now();
    if (left < 6000) break;
    const timeoutMs = k < chain.length - 1 ? Math.min(25_000, left - 5000) : left - 1500;
    try {
      const out = await chatWithModel({ apiKey, model: m, timeoutMs, ...rest });
      sick.delete(m);
      onModel?.(m);
      if (m !== model) onFallback?.({ from: model, to: m, reason: String(firstErr?.message || "").slice(0, 160) });
      return out;
    } catch (e) {
      lastErr = e; firstErr ||= e;
      if (fatal(e)) throw e;
      sick.set(m, Date.now() + SICK_MS);
    }
  }
  throw lastErr || new Error("모델들이 제한 시간 안에 응답하지 않았어요.");
}

async function chatWithModel({ apiKey, model, system, user, temperature = 0.7, maxTokens = 2500, cachePrefixLen = 0, onUsage, timeoutMs = 50_000 }) {
  const until = Date.now() + timeoutMs;
  const base = { apiKey, model, system, user, temperature, maxTokens, cachePrefixLen, onUsage };
  const left = () => { const t = until - Date.now(); if (t < 3000) { const e = new Error("이 모델에 쓸 시간이 다 됐어요."); e.status = 408; throw e; } return t; };
  let content;
  try {
    content = await callOnce({ ...base, jsonMode: true, lightReasoning: true, timeoutMs: left() });
  } catch (e) {
    // 모델이 JSON 모드나 추론 옵션을 지원하지 않으면 옵션 없이 다시
    if (e.status === 400 && !/deprecat|not a valid model|no endpoints|not found|is not available/i.test(e.message || "")) content = await callOnce({ ...base, jsonMode: false, lightReasoning: false, timeoutMs: left() });
    else throw e;
  }
  try {
    return parseJSON(content);
  } catch {
    const retry = await callOnce({
      ...base, temperature: 0.3, jsonMode: false, lightReasoning: false, timeoutMs: left(),
      user: `${user}\n\n(중요: 설명 없이 JSON 객체 하나만 출력하세요.)`,
    });
    return parseJSON(retry);
  }
}
