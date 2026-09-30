// OpenRouter 호출. 키는 (1) 브라우저에서 보낸 사용자 키 → (2) 서버 환경변수 순서로 씁니다.
// 둘 다 없으면 모의 모드(mock.js)로 답합니다.

export function resolveKey(userKey) {
  if (process.env.MOCK_LLM === "1") return null;
  return userKey || process.env.OPENROUTER_API_KEY || null;
}

export function parseJSON(text) {
  if (!text) throw new Error("모델 응답이 비어 있어요.");
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`JSON을 찾지 못했어요: ${cleaned.slice(0, 120)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callOnce({ apiKey, model, system, user, temperature, maxTokens, jsonMode, lightReasoning }) {
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
          { role: "user", content: user },
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
    return data.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    if (e.name === "AbortError") throw new Error("모델 응답이 55초 안에 오지 않았어요.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function chatJSON({ apiKey, model, system, user, temperature = 0.7, maxTokens = 2500 }) {
  const base = { apiKey, model, system, user, temperature, maxTokens };
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
