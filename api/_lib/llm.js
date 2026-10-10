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

async function callOnce({ apiKey, model, system, user, temperature, maxTokens, jsonMode, lightReasoning, cachePrefixLen = 0, onUsage }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55_000);
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
    if (e.name === "AbortError") throw new Error("모델 응답이 55초 안에 오지 않았어요.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 모델이 지원 종료되었거나 없어졌다는 응답인지 (이때만 다른 모델로 바꿔 다시 불러요)
const modelGone = (e) => e?.status === 404 || (e?.status === 400 && /deprecat|not a valid model|no endpoints|not found|is not available/i.test(e.message || ""));

// model을 먼저 부르고, 지원 종료로 실패하면 fallbacks를 차례로 불러요. 실제로 쓴 모델은 onModel로 알려 줘요.
export async function chatJSON({ apiKey, model, fallbacks = [], onModel, ...rest }) {
  const chain = [model, ...fallbacks].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr;
  for (const m of chain) {
    try {
      const out = await chatWithModel({ apiKey, model: m, ...rest });
      onModel?.(m);
      return out;
    } catch (e) {
      lastErr = e;
      if (!modelGone(e)) throw e;
    }
  }
  throw lastErr;
}

async function chatWithModel({ apiKey, model, system, user, temperature = 0.7, maxTokens = 2500, cachePrefixLen = 0, onUsage }) {
  const base = { apiKey, model, system, user, temperature, maxTokens, cachePrefixLen, onUsage };
  let content;
  try {
    content = await callOnce({ ...base, jsonMode: true, lightReasoning: true });
  } catch (e) {
    // 모델이 JSON 모드나 추론 옵션을 지원하지 않으면 옵션 없이 다시
    if (e.status === 400) content = await callOnce({ ...base, jsonMode: false, lightReasoning: false });
    else throw e;
  }
  try {
    return parseJSON(content);
  } catch {
    const retry = await callOnce({
      ...base, temperature: 0.3, jsonMode: false, lightReasoning: false,
      user: `${user}\n\n(중요: 설명 없이 JSON 객체 하나만 출력하세요.)`,
    });
    return parseJSON(retry);
  }
}
