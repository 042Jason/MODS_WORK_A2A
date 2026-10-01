// 에이전트들의 A2A 엔드포인트 (JSON-RPC, A2A 1.0 SendMessage)
//   GET  /agents/{id}/.well-known/agent-card.json  → 명함
//   POST /agents/{id}                              → SendMessage
// 요청마다 자기 페르소나, 자기 모델, 자기 암호키로만 동작합니다.
//
// 관리용 HTTP 헤더 (A2A 메시지 본문과 분리)
//   x-openrouter-key   사용자가 웹에서 입력한 OpenRouter 키 (저장하지 않음)
//   x-agent-model      사용자가 웹에서 고른 모델 ID
//   x-meeting-passcode 인증키. 맞으면 운영자의 공용 키로 모델을 부름

import crypto from "node:crypto";
import { ID_BY_NAME, MEMBER_IDS, MEMBER_NAMES, PERSONAS, agentCard, defaultModelOf, isAllowedModel, sharedModelOf } from "./_lib/personas.js";
import { chatJSON, resolveKey } from "./_lib/llm.js";
import { mockFollowup, mockMember, mockModerate, mockSummary } from "./_lib/mock.js";
import { openState, sealState } from "./_lib/state.js";
import { SHARED_MAX_TURNS, passcodeOk } from "./_lib/auth.js";

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + "\n…(이하 생략)" : s || "");

function phaseGuide(phase = "round1") {
  if (phase === "round1") return "1라운드: 각자 첫 의견을 말하는 차례입니다.";
  if (phase === "last_word") return "최종 반론: 결론 전에 아직 가장 걸리는 점을 한 번 더 말하는 차례입니다. 양보할 것은 양보하고, 끝까지 짚고 싶은 한 가지를 분명히 하세요.";
  const n = parseInt(String(phase).replace("round", ""), 10) || 2;
  return `${n}라운드: 앞선 발언에 반론하거나 보완하는 차례입니다. 누군가의 발언을 이름으로 짚으며 시작하고, 이미 합의된 이야기는 반복하지 마세요.`;
}
const attendeeLine = (ids = MEMBER_IDS) => ids.filter((id) => PERSONAS[id]).map((id) => `${PERSONAS[id].name}(${PERSONAS[id].title})`).join(", ");

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

// 토론 주제와 첨부 자료. 주제는 사용자가 적은 문장, 자료는 있을 때만.
function agenda(input, limit) {
  const topic = String(input.topic || "").trim();
  const doc = input.document || {};
  const files = doc.text ? `[첨부 자료${doc.name ? `: ${doc.name}` : ""}]\n${clip(doc.text, limit)}` : "[첨부 자료] (없음. 일반 지식으로 토론합니다.)";
  if (!topic && doc.text && !input.topic) return `[검토 대상 문서: ${doc.name || "제목 없음"}]\n${clip(doc.text, limit)}`;   // 예전 회의실 호환
  return `[토론 주제]\n${topic || "(주제 문장 없음. 첨부 자료를 검토해 주세요.)"}\n\n${files}`;
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
  const { document, transcript = [], phase = "round1", turn = 1, totalTurns = 12, eligible = MEMBER_IDS, attendees = MEMBER_IDS, hint = "" } = input;
  const pool = eligible.filter((id) => MEMBER_IDS.includes(id));
  const out = llm.mock ? mockModerate({ transcript, phase, eligible: pool, hasDoc: !!document?.text }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.4, maxTokens: 1200,
    user: `${agenda(input, 5000)}

[지금까지 회의록]
${transcriptText(transcript)}

[이번 회의 참석자] ${attendeeLine(attendees)}
[진행 상황] 전체 ${totalTurns}턴 중 ${turn}번째 발언 차례. ${phaseGuide(phase)}
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
  return { text: say, data: { next, nextName: name, phase, thoughts: String(out.reason || "") }, newState };
}

// ── 사회자: 결론 ─────────────────────────────────────────────────────
async function summarize(llm, persona, input, state) {
  const { document, transcript = [], totalTurns = 12 } = input;
  const review = llm.mock ? mockSummary({ document, topic: input.topic }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.3, maxTokens: 3500,
    user: `${agenda(input, 16000)}

[회의록]
${transcriptText(transcript)}

이제 마지막(${totalTurns}번째) 턴, 결론입니다. 회의에서 나온 의견만 담아 정리하세요.
찬반 토론이면 모인 결론과 근거를, 아이디어 회의면 고른 아이디어와 실행 방법을, 자료 검토면 고칠 점과 제안을 key_points에 담습니다.
의견이 갈린 부분은 concerns나 open_questions에 남기고, 누가 제기했는지 raised_by에 이름을 적습니다.
JSON 하나만 출력합니다.
{
  "verdict": "주제에 맞는 판정 10자 이내 (예: 찬성 우세, 반대 우세, 조건부 합의, 의견 갈림, 보완 후 진행, 다시 논의)",
  "tone": "positive (대체로 찬성하거나 진행해도 좋음)" | "mixed (조건부, 보완 필요)" | "negative (반대 우세이거나 다시 봐야 함)" 중 영어 단어 하나,
  "headline": "결론 한두 문장",
  "key_points": [{"title": "핵심 결론이나 제안", "detail": "근거나 방법", "where": "자료 위치(있을 때만)", "raised_by": "이름"}],
  "concerns": [{"title": "우려나 반대 의견", "detail": "보완 방법", "raised_by": "이름"}],
  "agreements": ["모두 동의한 점"],
  "open_questions": ["결론 나지 않은 질문"],
  "closing": "사회자 마무리 멘트 1~2문장"
}`,
  });
  if (!["positive", "mixed", "negative"].includes(review.tone)) review.tone = String(review.tone || "").match(/positive|negative/)?.[0] || "mixed";
  return {
    text: review.closing || "오늘 토론의 결론을 정리했습니다.",
    artifacts: [{ artifactId: uid(), name: "결론", parts: [{ data: review }] }],
    newState: { ...state, turns: state.turns + 1 },
  };
}

// ── 참석자: 발언 ─────────────────────────────────────────────────────
async function reviewTurn(llm, persona, input, state) {
  const { document, transcript = [], request, turn = 1, totalTurns = 12, phase = "round1", attendees = MEMBER_IDS } = input;
  const myTurn = (state.turns || 0) + 1;
  const out = llm.mock ? mockMember(persona.id, { document, myTurn, phase, topic: input.topic }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.8, maxTokens: 2500,
    user: `${agenda(input, 24000)}

[지금까지 회의록]
${transcriptText(transcript)}

[당신의 지난 속마음 (다른 참석자에게는 전달되지 않음)]
${state.notes || "(아직 없음)"}

[이번 회의 참석자] ${attendeeLine(attendees)}
[지금 차례] 전체 ${totalTurns}턴 중 ${turn}번째. ${phaseGuide(phase)}
사회자가 당신에게: "${request?.text || "의견 부탁드립니다."}"
${myTurn === 1 ? "주제와 자료를 보고 당신 관점에서 가장 중요한 한 가지부터 말하세요." : "지난 메모와 다른 사람 발언을 참고해, 이미 한 말은 반복하지 마세요."}`,
  });
  const utterance = String(out.utterance || "").trim() || "잠시 생각을 정리해 볼게요.";
  const stance = ["동의", "우려", "보류"].includes(out.stance) ? out.stance : "보류";
  const confidence = Math.max(0, Math.min(100, parseInt(out.confidence, 10) || 50));
  const names = attendees.map((id) => PERSONAS[id]?.name).filter(Boolean);
  const ask = out.ask?.to && MEMBER_NAMES.includes(out.ask.to) && names.includes(out.ask.to) && out.ask.to !== persona.name
    ? { to: out.ask.to, question: String(out.ask.question || "") } : null;
  const newState = {
    ...state, turns: myTurn,
    notes: clip(String(out.private_notes || state.notes || ""), 1200),
    said: [...(state.said || []), utterance].slice(-6),
    stances: [...(state.stances || []), { turn, stance, confidence }],
  };
  return { text: utterance, data: { stance, confidence, ask, phase, thoughts: newState.notes }, newState };
}

// ── 회의 뒤 후속 질문 (사회자, 참석자 모두) ───────────────────────────────
function reviewText(review) {
  if (!review) return "(결론 없음)";
  const line = (x) => `- ${x.title || x.issue}${x.raised_by ? ` (${x.raised_by})` : ""}`;
  const keys = (review.key_points || review.must_fix || []).map(line).join("\n");
  const worry = (review.concerns || review.consider || []).map(line).join("\n");
  return `판정: ${review.verdict}\n결론: ${review.headline}\n핵심 결론과 제안:\n${keys || "- 없음"}\n우려와 반대 의견:\n${worry || "- 없음"}`;
}
async function followup(llm, persona, input, state) {
  const { document, transcript = [], review, question = "", thread = [] } = input;
  const isMod = persona.id === "moderator";
  const out = llm.mock ? mockFollowup(persona.id, { question, review }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.6, maxTokens: 1800,
    user: `${agenda(input, 16000)}

[회의록]
${transcriptText(transcript)}

[회의 결론]
${reviewText(review)}

[지금까지의 후속 질문과 답]
${thread.length ? thread.slice(-8).map((t) => `사용자 → ${t.to}: ${t.question}\n${t.to}: ${t.answer}`).join("\n") : "(없음)"}

[당신의 지난 속마음]
${state.notes || "(없음)"}

[지금 할 일]
회의가 끝났고, 사용자가 ${isMod ? "사회자인 당신" : `${persona.name} 님(당신)`}에게 직접 질문했습니다: "${String(question).slice(0, 1000)}"
${isMod ? "사회자로서 회의 전체 의견을 종합해 답하세요. 누가 어떤 의견이었는지 이름을 들어 설명해도 좋습니다." : "당신의 역할과 관점, 말투를 유지하세요."}
회의 발언 형식은 잊고 질문에 바로 답하세요. 3~6문장, 필요하면 근거가 된 자료 위치를 짚고, 모르는 것은 모른다고 말하세요.
JSON 하나만 출력합니다: {"answer": "질문에 대한 답", "private_notes": "속마음 (1~2문장)"}`,
  });
  const answer = String(out.answer || out.utterance || "").trim() || "잠시 생각을 정리해 볼게요.";
  const notes = clip(String(out.private_notes || state.notes || ""), 1200);
  return { text: answer, data: { thoughts: String(out.private_notes || "") }, newState: { ...state, notes } };
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
  // 내 키가 있으면 내 키, 없으면 인증키가 맞는 경우에만 공용 키, 그것도 아니면 모의 모드
  const userKey = String(req.headers["x-openrouter-key"] || "").trim() || null;
  const apiKey = resolveKey(userKey, passcodeOk(req));
  // 모델은 '내 키'로 부를 때만 바꿀 수 있어요. 공용 키일 때는 운영자가 정한 기본 모델(MODEL_*)로 고정해요.
  const wanted = String(req.headers["x-agent-model"] || "").trim();
  if (userKey && wanted && !isAllowedModel(wanted)) {
    return rpcError(res, body.id, -32602, `허용되지 않은 모델이에요: ${wanted}`);
  }
  // 내 키: 고른 모델(없으면 기본 모델). 공용 키: 운영자가 정한 가벼운 모델.
  const model = userKey ? (wanted || defaultModelOf(persona)) : apiKey ? sharedModelOf(persona) : defaultModelOf(persona);
  const llm = { apiKey, model, mock: !apiKey };

  const input = msg.parts.find((p) => p.data)?.data || {};
  // 공용 키로는 회의를 SHARED_MAX_TURNS턴까지만 (토큰 비용 보호)
  if (apiKey && !userKey && ["moderate", "review_turn", "summarize"].includes(input.type)
      && (Number(input.totalTurns) > SHARED_MAX_TURNS || Number(input.turn) > SHARED_MAX_TURNS)) {
    return rpcError(res, body.id, -32602, `공용 키로는 최대 ${SHARED_MAX_TURNS}턴까지 회의할 수 있어요. 턴 수를 줄이거나 내 API 키를 넣어 주세요.`);
  }
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
    else if (input.type === "followup") r = await followup(llm, persona, input, state);
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
