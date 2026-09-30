// 에이전트들의 A2A 엔드포인트 (JSON-RPC, A2A 1.0 SendMessage)
//   GET  /agents/{id}/.well-known/agent-card.json  → 명함
//   POST /agents/{id}                              → SendMessage
// 요청마다 자기 페르소나, 자기 모델, 자기 암호키로만 동작합니다.
//
// 관리용 HTTP 헤더 (A2A 메시지 본문과 분리)
//   x-openrouter-key   사용자가 웹에서 입력한 OpenRouter 키 (저장하지 않음)
//   x-agent-model      사용자가 웹에서 고른 모델 ID
//   x-meeting-passcode 서버 키를 쓸 때 필요한 입장 암호

import crypto from "node:crypto";
import { ID_BY_NAME, MEMBER_IDS, MEMBER_NAMES, PERSONAS, agentCard, defaultModelOf, isAllowedModel } from "./_lib/personas.js";
import { chatJSON, resolveKey } from "./_lib/llm.js";
import { mockMember, mockModerate, mockSummary } from "./_lib/mock.js";
import { openState, sealState } from "./_lib/state.js";

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + "\n…(이하 생략)" : s || "");

const PHASE_GUIDE = {
  round1: "1라운드: 각자 첫 의견을 말하는 차례입니다.",
  round2: "2라운드: 앞선 발언에 반론하거나 보완하는 차례입니다. 누군가의 발언을 이름으로 짚으며 시작하세요.",
  last_word: "최종 반론: 결론 전에 아직 가장 걸리는 점을 한 번 더 말하는 차례입니다. 양보할 것은 양보하고, 끝까지 고쳐야 할 한 가지를 분명히 하세요.",
};

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}
const rpcError = (res, id, code, message) => res.status(200).json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const agentMessage = (ctx, parts) => ({ messageId: uid(), contextId: ctx.contextId, taskId: ctx.taskId, role: "ROLE_AGENT", parts });

function taskResult(ctx, { state = "TASK_STATE_COMPLETED", text, data, artifacts = [], stateToken }) {
  const parts = [{ text }];
  if (data) parts.push({ data });
  return { task: {
    id: ctx.taskId, contextId: ctx.contextId,
    status: { state, message: agentMessage(ctx, parts), timestamp: now() },
    artifacts, metadata: stateToken ? { stateToken } : {},
  } };
}

function transcriptText(transcript = []) {
  if (!transcript.length) return "(아직 발언 없음)";
  return transcript.slice(-30).map((t) => {
    const ask = t.ask?.to ? ` [→ ${t.ask.to}에게 질문: ${t.ask.question}]` : "";
    return `${t.speaker}: ${t.text}${ask}`;
  }).join("\n");
}

// ── 사회자: 다음 발언자 정하기 ────────────────────────────────────────
async function moderate(llm, persona, input, state) {
  const { document, transcript = [], phase = "round1", turn = 1, eligible = MEMBER_IDS, hint = "" } = input;
  const pool = eligible.filter((id) => MEMBER_IDS.includes(id));
  const out = llm.mock ? mockModerate({ transcript, phase, eligible: pool }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.4, maxTokens: 1200,
    user: `[검토 대상 문서: ${document?.name || "제목 없음"}] (앞부분)
${clip(document?.text, 5000)}

[지금까지 회의록]
${transcriptText(transcript)}

[진행 상황] 전체 12턴 중 ${turn}번째 발언 차례. ${PHASE_GUIDE[phase] || ""}
이번에 말할 수 있는 사람(eligible): ${pool.map((id) => `${id}(${PERSONAS[id].name})`).join(", ")}
${hint ? `참고: ${hint}` : ""}
${transcript.length === 0 ? "첫 차례이니 say 앞에 짧은 개회 멘트를 붙이세요." : ""}
[지난 진행 메모(당신만 봄)] ${state.notes || "(없음)"}

JSON 하나만 출력합니다.
{"next": "eligible 중 하나의 id", "say": "다음 발언자 이름을 부르며 하는 말 (1~2문장)", "reason": "왜 이 사람인지 (메모용, 공개 안 됨)"}`,
  });
  let next = pool.includes(out.next) ? out.next : pool.includes(ID_BY_NAME[out.next]) ? ID_BY_NAME[out.next] : null;
  const fixed = !next;
  if (!next) next = pool[0];
  const name = PERSONAS[next].name;
  const say = !fixed && out.say ? String(out.say) : `${name} 님 의견 부탁드립니다.`;
  const newState = { ...state, turns: state.turns + 1, notes: clip(`${state.notes}\n${turn}: ${out.reason || ""}`.trim(), 1500) };
  return { text: say, data: { next, nextName: name, phase }, newState };
}

// ── 사회자: 결론 ─────────────────────────────────────────────────────
async function summarize(llm, persona, input, state) {
  const { document, transcript = [] } = input;
  const review = llm.mock ? mockSummary({ document }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.3, maxTokens: 3500,
    user: `[검토 대상 문서: ${document?.name || "제목 없음"}]
${clip(document?.text, 16000)}

[회의록]
${transcriptText(transcript)}

이제 12번째 턴, 결론입니다. 회의에서 나온 의견만 담아 검토결과를 정리하세요.
의견이 갈린 부분은 open_questions에 남기고, 누가 제기했는지 raised_by에 이름을 적습니다.
JSON 하나만 출력합니다.
{
  "verdict": "배포 가능" | "수정 후 배포" | "재검토 필요",
  "headline": "한 줄 총평",
  "must_fix": [{"where": "문서 위치", "issue": "문제", "suggestion": "고칠 방법", "raised_by": "이름"}],
  "consider": [{"issue": "검토하면 좋을 점", "suggestion": "제안", "raised_by": "이름"}],
  "strengths": ["잘된 점"],
  "open_questions": ["결론 나지 않은 질문"],
  "closing": "사회자 마무리 멘트 1~2문장"
}`,
  });
  return {
    text: review.closing || "검토결과를 정리했습니다.",
    artifacts: [{ artifactId: uid(), name: "검토결과", parts: [{ data: review }] }],
    newState: { ...state, turns: state.turns + 1 },
  };
}

// ── 참석자: 발언 ─────────────────────────────────────────────────────
async function reviewTurn(llm, persona, input, state) {
  const { document, transcript = [], request, turn = 1, phase = "round1" } = input;
  const myTurn = (state.turns || 0) + 1;
  const out = llm.mock ? mockMember(persona.id, { document, myTurn, phase }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.8, maxTokens: 2500,
    user: `[검토 대상 문서: ${document?.name || "제목 없음"}]
${clip(document?.text, 24000)}

[지금까지 회의록]
${transcriptText(transcript)}

[당신의 지난 메모 (당신만 봄)]
${state.notes || "(아직 없음)"}

[지금 차례] 전체 12턴 중 ${turn}번째. ${PHASE_GUIDE[phase] || ""}
사회자가 당신에게: "${request?.text || "의견 부탁드립니다."}"
${myTurn === 1 ? "문서를 읽고 당신 관점에서 가장 중요한 한 가지부터 말하세요." : "지난 메모와 다른 사람 발언을 참고해, 이미 한 말은 반복하지 마세요."}`,
  });
  const utterance = String(out.utterance || "").trim() || "잠시 생각을 정리해 볼게요.";
  const stance = ["동의", "우려", "보류"].includes(out.stance) ? out.stance : "보류";
  const confidence = Math.max(0, Math.min(100, parseInt(out.confidence, 10) || 50));
  const ask = out.ask?.to && MEMBER_NAMES.includes(out.ask.to) && out.ask.to !== persona.name
    ? { to: out.ask.to, question: String(out.ask.question || "") } : null;
  const newState = {
    ...state, turns: myTurn,
    notes: clip(String(out.private_notes || state.notes || ""), 1200),
    said: [...(state.said || []), utterance].slice(-6),
    stances: [...(state.stances || []), { turn, stance, confidence }],
  };
  return { text: utterance, data: { stance, confidence, ask, phase }, newState };
}

// ── 연결 확인 ────────────────────────────────────────────────────────
async function ping(llm, persona) {
  if (llm.mock) return { text: "모의 모드라 실제 모델은 부르지 않았어요.", data: { ok: true, mock: true, model: llm.model } };
  const started = Date.now();
  const out = await chatJSON({
    ...llm, system: "연결 확인용입니다.", temperature: 0, maxTokens: 300,
    user: `JSON 하나만 출력: {"ok": true, "hello": "${persona.name}입니다를 한국어 한 문장으로"}`,
  });
  return { text: String(out.hello || "연결됐어요."), data: { ok: true, model: llm.model, ms: Date.now() - started } };
}

// ── 요청 처리 ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const persona = PERSONAS[req.query.agent];
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-meeting-passcode, x-openrouter-key, x-agent-model");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!persona) return res.status(404).json({ error: "그런 에이전트는 없어요." });
  if (req.method === "GET") return res.status(200).json(agentCard(persona, baseUrl(req)));
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 받아요." });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (body.method !== "SendMessage") return rpcError(res, body.id, -32601, `지원하지 않는 메서드: ${body.method}`);
  const msg = body.params?.message;
  if (!msg?.parts) return rpcError(res, body.id, -32602, "message.parts가 필요해요.");

  // 키와 모델 결정
  const userKey = String(req.headers["x-openrouter-key"] || "").trim() || null;
  const apiKey = resolveKey(userKey);
  const pass = process.env.MEETING_PASSCODE;
  if (apiKey && !userKey && pass && req.headers["x-meeting-passcode"] !== pass) {
    return rpcError(res, body.id, -32001, "서버 키를 쓰려면 입장 암호가 필요해요. 설정에서 암호를 넣거나 본인 API 키를 넣어 주세요.");
  }
  const wanted = String(req.headers["x-agent-model"] || "").trim();
  if (wanted && !isAllowedModel(wanted)) {
    return rpcError(res, body.id, -32602, `허용되지 않은 모델이에요: ${wanted}`);
  }
  const llm = { apiKey, model: wanted || defaultModelOf(persona), mock: !apiKey };

  const input = msg.parts.find((p) => p.data)?.data || {};
  const ctx = { contextId: msg.contextId || uid(), taskId: msg.taskId || uid() };
  const state = openState(persona.id, msg.metadata?.stateToken);

  try {
    // 속마음 공개: 작업 없이 메시지로 바로 답합니다.
    if (input.type === "reveal") {
      const text = state.notes ? state.notes : "아직 적어 둔 메모가 없어요.";
      return res.status(200).json({ jsonrpc: "2.0", id: body.id, result: {
        message: agentMessage({ contextId: ctx.contextId }, [{ text }, { data: { notes: state.notes, stances: state.stances } }]),
      } });
    }

    let r;
    const isMod = persona.id === "moderator";
    if (input.type === "ping") r = { ...(await ping(llm, persona)), newState: state };
    else if (isMod && input.type === "moderate") r = await moderate(llm, persona, input, state);
    else if (isMod && input.type === "summarize") r = await summarize(llm, persona, input, state);
    else if (!isMod && input.type === "review_turn") r = await reviewTurn(llm, persona, input, state);
    else return rpcError(res, body.id, -32602, `${persona.name}은(는) '${input.type}' 요청을 처리하지 않아요.`);

    const result = taskResult(ctx, {
      text: r.text, data: { ...r.data, model: llm.mock ? "mock" : llm.model },
      artifacts: r.artifacts, stateToken: sealState(persona.id, r.newState),
    });
    return res.status(200).json({ jsonrpc: "2.0", id: body.id, result });
  } catch (e) {
    const result = taskResult(ctx, {
      state: "TASK_STATE_FAILED",
      text: `답을 만들지 못했어요. ${String(e.message || e).slice(0, 240)}`,
      data: { model: llm.model },
      stateToken: msg.metadata?.stateToken,
    });
    return res.status(200).json({ jsonrpc: "2.0", id: body.id, result });
  }
}
