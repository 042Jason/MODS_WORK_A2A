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

// 2라운드부터는 라운드마다 성격을 바꿔요. 턴을 늘려도 반박만 되풀이하지 않게 (6라운드 다음은 다시 반박부터)
const ROUND_GUIDE = [
  "반박 타임: 앞선 발언에 반론하거나 보완하는 차례입니다. 누군가의 발언을 이름으로 짚으며 시작하고, 이미 합의된 이야기는 반복하지 마세요.",
  "대안 타임: 문제를 지적하는 데서 그치지 말고, 지금까지 나온 걱정을 풀 구체적인 대안이나 개선안을 하나 내놓는 차례입니다. 가능하면 다른 참석자의 아이디어에 덧붙이세요.",
  "입장 바꿔 보기: 나와 가장 다른 시각을 가진 참석자의 입장을 가장 설득력 있게 대신 말해 본 뒤, 그래도 내 입장에서 남는 점이나 바뀐 점을 말하는 차례입니다.",
  "합의점 찾기: 지금까지 나온 의견 중 다 같이 동의할 수 있는 지점과 아직 갈리는 지점을 짚고, 갈리는 지점에 대해 내 생각을 분명히 하는 차례입니다.",
  "실행 계획: 결론이 난다고 가정하고, 실제로 무엇부터 누가 어떻게 할지 구체적인 다음 단계를 말하는 차례입니다.",
];
// 오늘의 배지: 사회자가 결론을 정리하며 회의에서 실제로 한 일을 보고 나눠 줘요
const BADGE_GUIDE = {
  question: "질문왕: 날카로운 질문을 가장 많이 던짐",
  persuaded: "생각 전환: 토론하며 생각을 바꿈",
  shield: "소신파: 끝까지 자기 시각을 지킴",
  mic: "마지막 한마디: 결론 직전에 중요한 반론을 냄",
  talk: "수다왕: 가장 많이, 가장 길게 이야기함",
  magnifier: "날카로운 지적: 다들 놓친 문제를 짚음",
  handshake: "합의 도우미: 의견을 모으는 데 기여함",
  bulb: "아이디어 뱅크: 좋은 제안이나 대안을 냄",
};
function pickBadges(raw, names) {   // 이름·배지 키 검증, 한 사람에 2개까지
  const out = [], count = {};
  for (const b of Array.isArray(raw) ? raw : []) {
    const to = String(b?.to || "").replace(/\s*님$/, "").trim(), key = String(b?.badge || "").trim();
    if (!names.includes(to) || !BADGE_GUIDE[key] || (count[to] || 0) >= 2 || out.some((x) => x.to === to && x.badge === key)) continue;
    count[to] = (count[to] || 0) + 1;
    out.push({ to, badge: key, reason: String(b.reason || "").trim().slice(0, 120) });
  }
  return out;
}
const MOCK_BADGE = { critic: ["magnifier", "근거부터 따지자는 말로 논의의 기준을 세웠어요."], strategist: ["bulb", "작게 시작해 넓히자는 방향을 제일 먼저 내놨어요."],
  reader: ["handshake", "쉬운 말로 풀어 주면서 의견이 모이게 도왔어요."], method: ["question", "성공 기준을 먼저 정하자고 계속 물었어요."], policy: ["shield", "반발 대책이 먼저라는 시각을 끝까지 지켰어요."] };
// 사용자도 참석할 때 프롬프트에 넣는 소개
const userLine = (u) => (u?.name ? `${u.name}(사용자${u.title ? `, ${u.title}` : ""})` : "");
const userIntro = (u) => (u?.name ? `\n[사용자 참석] ${userLine(u)}도 이 회의에 함께합니다.${u.about ? ` 소개: ${String(u.about).slice(0, 300)}` : ""} 회의록에는 '${u.name}(사용자)'로 나옵니다.` : "");
function phaseGuide(phase = "round1") {
  if (phase === "round1") return "1라운드: 각자 첫 의견을 말하는 차례입니다.";
  if (phase === "last_word") return "최종 반론: 결론 전에 아직 가장 걸리는 점을 한 번 더 말하는 차례입니다. 양보할 것은 양보하고, 끝까지 짚고 싶은 한 가지를 분명히 하세요.";
  if (String(phase).startsWith("more")) return "추가 토론: 사용자가 회의 뒤에 새 요청이나 자료를 줬습니다. [토론 주제]의 [추가 요청]과 [앞선 결론]을 보고, 새 요청을 중심으로 무엇이 바뀌거나 더해지는지 말하세요. 앞선 회의에서 한 말은 반복하지 마세요.";
  const n = parseInt(String(phase).replace("round", ""), 10) || 2;
  return `${n}라운드 · ${ROUND_GUIDE[(n - 2) % ROUND_GUIDE.length]}`;
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

// 속마음·이유 앞에 모델이 붙이는 머리말("속마음:", "이유 -", "[Inner]" 등)을 떼어 내요
const NOTE_LABEL = /^\s*(?:[\[(（【]\s*(?:속마음|속\s*마음|내\s*생각|생각|이유|판단\s*이유|메모|private[_ ]?notes?|inner(?:\s*notes?)?|thoughts?|why|reason)\s*[\])）】]\s*[:：\-–—]?|(?:속마음|속\s*마음|내\s*생각|생각|이유|판단\s*이유|메모|private[_ ]?notes?|inner(?:\s*notes?)?|thoughts?|why|reason)\s*[:：\-–—])\s*/i;
export const cleanNote = (s) => String(s || "").replace(NOTE_LABEL, "").trim();

// 토론 주제와 첨부 자료. 주제는 사용자가 적은 문장, 자료는 있을 때만.
// 긴 자료를 앞부분만 자르면 뒤쪽 내용을 아예 못 봐요. 앞 절반 + 나머지에서 고르게 6군데를 뽑아 전체 흐름이 보이게 해요.
function clipDoc(text, limit) {
  if (!text || text.length <= limit) return { text: text || "", cut: false };
  const head = Math.floor(limit * 0.5), k = 6, seg = Math.floor((limit - head) / k), tail = text.length - head;
  const parts = [text.slice(0, head)];
  for (let i = 0; i < k; i++) {
    const start = head + Math.floor(((tail - seg) * (i + 1)) / k);
    parts.push(`\n\n…(중략)…\n\n${text.slice(start, start + seg)}`);
  }
  return { text: parts.join(""), cut: true };
}

function agenda(input, limit) {
  const topic = String(input.topic || "").trim();
  const doc = input.document || {};
  const d = clipDoc(doc.text, limit);
  const note = d.cut ? `(자료가 ${doc.text.length.toLocaleString()}자로 길어서 앞부분과 뒤쪽 여러 군데를 발췌했어요. 발췌에 없는 내용은 추측하지 말고 확인이 필요하다고 말하세요.)\n` : "";
  const files = doc.text ? `[첨부 자료${doc.name ? `: ${doc.name}` : ""}]\n${note}${d.text}` : "[첨부 자료] (없음. 일반 지식으로 토론합니다.)";
  if (!topic && doc.text && !input.topic) return `[검토 대상 문서: ${doc.name || "제목 없음"}]\n${note}${d.text}`;   // 예전 회의실 호환
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
  // 흐름을 읽을 재료: 누가 몇 번 말했는지, 직전 발언자와 질문, 각자 지금 입장, 지금까지 다룬 쟁점
  const said = (id) => transcript.filter((t) => t.role === id).length;
  const lastTalk = [...transcript].reverse().find((t) => t.role !== "moderator");
  const standing = input.standing || {};
  const flow = [
    `[발언 현황] ${attendees.filter((id) => PERSONAS[id]).map((id) => `${PERSONAS[id].name} ${said(id)}번${standing[id]?.position ? ` · 지금 입장 '${standing[id].position}'(${({ 동의: "모이는 의견과 같은 방향", 우려: "다른 시각", 보류: "고민 중" })[standing[id].stance] || "?"})` : ""}`).join(" / ")}`,
    lastTalk ? `[직전 발언] ${lastTalk.speaker}${lastTalk.ask?.to ? ` (→ ${lastTalk.ask.to}에게 질문: ${lastTalk.ask.question})` : ""}` : "",
    (state.issues || []).length ? `[지금까지 다룬 쟁점] ${state.issues.slice(-6).join(" → ")}` : "",
    input.roundStart && transcript.length ? "이번이 이 라운드의 첫 차례입니다. say에서 지금까지 흐름을 한 문장으로 짚고, 이번 라운드에 무엇을 할지 소개한 뒤 첫 사람을 부르세요." : "",
  ].filter(Boolean).join("\n");
  const out = llm.mock ? mockModerate({ transcript, phase, eligible: pool, hasDoc: !!document?.text, roundStart: input.roundStart, standing: input.standing || {} }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.4, maxTokens: 1200,
    user: `${agenda(input, 10000)}

[지금까지 회의록]
${transcriptText(transcript)}

[이번 회의 참석자] ${attendeeLine(attendees)}${input.user?.name ? `, ${userLine(input.user)}` : ""}${userIntro(input.user)}
[진행 상황] 전체 ${totalTurns}턴 중 ${turn}번째 발언 차례. ${phaseGuide(phase)}
${flow}
이번에 말할 수 있는 사람(eligible): ${pool.map((id) => `${id}(${PERSONAS[id].name})`).join(", ")}
${hint ? `참고: ${hint}` : ""}
${transcript.length === 0 ? "첫 차례이니 say 앞에 짧은 개회 멘트를 붙이세요." : ""}
[지난 진행 메모(당신만 봄)] ${state.notes || "(없음)"}

JSON 하나만 출력합니다.
{"next": "eligible 중 하나의 id", "issue": "이번 차례에 다룰 쟁점 (15자 이내)", "say": "다음 발언자 이름을 부르며 하는 말 (1~2문장, 라운드 첫 차례는 최대 3문장)", "reason": "왜 이 사람에게 지금 발언권을 주는지 (메모용, 공개 안 됨)"${input.user?.name ? `, "ask_user": "사용자 ${input.user.name}의 경험·상황·선호를 알아야 판단할 수 있거나, 의견이 팽팽해서 사용자 생각을 들으면 좋을 때만, next보다 먼저 사용자에게 따로 묻는 질문 한 문장('${input.user.name} 님,'으로 시작). say는 그대로 next에게 하는 말로 씁니다. 필요 없으면 빈 문자열. 라운드마다 많아야 한 번"` : ""}}`,
  });
  let next = pool.includes(out.next) ? out.next : pool.includes(ID_BY_NAME[out.next]) ? ID_BY_NAME[out.next] : null;
  const fixed = !next;
  if (!next) next = pool[0];
  const name = PERSONAS[next].name;
  const say = !fixed && out.say ? String(out.say) : `${name} 님 의견 부탁드립니다.`;
  const issue = String(out.issue || "").replace(/^쟁점\s*[:：]\s*/, "").trim().slice(0, 24);
  const issues = issue && (state.issues || []).at(-1) !== issue ? [...(state.issues || []), issue].slice(-12) : state.issues || [];
  const newState = { ...state, turns: state.turns + 1, issues, notes: clip(`${state.notes}\n${turn}: ${out.reason || ""}`.trim(), 1500) };
  let askUser = input.user?.name ? String(out.ask_user || "").trim().slice(0, 200) : "";
  // 모의 모드에서도 흐름을 볼 수 있게: 2라운드 첫 차례에 한 번 사용자에게 물어요
  if (llm.mock && input.user?.name && phase === "round2" && !transcript.some((t) => t.role === "me")) askUser = `${input.user.name} 님은 이 주제를 직접 겪는 입장에서 어떻게 보세요?`;
  return { text: say, data: { next, nextName: name, phase, issue, askUser, thoughts: cleanNote(out.reason) }, newState };
}

// ── 사회자: 결론 ─────────────────────────────────────────────────────
async function summarize(llm, persona, input, state) {
  const { document, transcript = [], totalTurns = 12 } = input;
  const early = !!input.early, doneTurns = Number(input.doneTurns) || transcript.length;
  const prev = input.previousReview;   // 추가 회의라면 앞선 결론
  const prevNote = prev ? `\n[앞선 결론] ${prev.verdict || ""}: ${prev.headline || ""}\n이번은 그 뒤에 이어진 추가 회의입니다. 앞선 결론을 바탕으로, 추가 회의에서 바뀌거나 더해진 점을 반영해 결론을 새로 정리하세요. 달라진 점은 headline에 드러나게 쓰세요.` : "";
  const when = early
    ? `회의를 전체 ${totalTurns}턴 중 ${doneTurns}턴까지만 하고 여기서 일찍 마무리합니다. 지금까지 나온 의견만 담아 결론을 정리하세요. 아직 다루지 못한 쟁점은 open_questions에 남기세요.`
    : `이제 마지막(${totalTurns}번째) 턴, 결론입니다. 회의에서 나온 의견만 담아 정리하세요.`;
  const review = llm.mock ? mockSummary({ document, topic: input.topic }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.3, maxTokens: 3500,
    user: `${agenda(input, 30000)}

[회의록]
${transcriptText(transcript)}

${when}${prevNote}
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
  "closing": "사회자 마무리 멘트 1~2문장",
  "private_notes": "사회자로서 회의를 마치며 드는 솔직한 생각 1~2문장 (머리말 없이)",
  "badges": [{"to": "받는 사람 이름", "badge": "배지 키", "reason": "왜 이 배지인지 사회자가 건네는 한 문장 (~해요 체)"}]
}
[오늘의 배지] 사회자로서 참석자마다 회의에서 실제로 한 일에 맞는 배지를 1~2개 주세요. 근거 없이 주지 말고, 같은 배지를 여러 명에게 줘도 됩니다. 사회자 자신은 받지 않습니다.
참석자: ${(input.attendees || []).map((id) => PERSONAS[id]?.name).filter(Boolean).join(", ")}${input.user?.name && transcript.some((t) => t.role === "me") ? `, ${input.user.name}(사용자, 발언했다면 1개)` : ""}
배지 키: ${Object.entries(BADGE_GUIDE).map(([k, v]) => `${k}(${v})`).join(", ")}`,
  });
  if (!["positive", "mixed", "negative"].includes(review.tone)) review.tone = String(review.tone || "").match(/positive|negative/)?.[0] || "mixed";
  const thoughts = cleanNote(review.private_notes); delete review.private_notes;
  const names = [...(input.attendees || []).map((id) => PERSONAS[id]?.name).filter(Boolean), ...(input.user?.name && transcript.some((t) => t.role === "me") ? [input.user.name] : [])];
  review.badges = llm.mock
    ? [...(input.attendees || []).filter((id) => MOCK_BADGE[id]).map((id) => ({ to: PERSONAS[id].name, badge: MOCK_BADGE[id][0], reason: MOCK_BADGE[id][1] })),
       ...(names.includes(input.user?.name) ? [{ to: input.user.name, badge: "talk", reason: "현장 이야기를 직접 들려줘서 토론이 훨씬 구체적이 됐어요." }] : [])]
    : pickBadges(review.badges, names);
  if (early) review.early = { doneTurns, totalTurns };
  return {
    text: review.closing || "오늘 토론의 결론을 정리했습니다.",
    data: { thoughts },
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
    user: `${agenda(input, 36000)}

[지금까지 회의록]
${transcriptText(transcript)}

[당신의 지난 속마음 (다른 참석자에게는 전달되지 않음)]
${state.notes || "(아직 없음)"}

[이번 회의 참석자] ${attendeeLine(attendees)}${input.user?.name ? `, ${userLine(input.user)}` : ""}${userIntro(input.user)}${input.user?.name ? `\n사용자 ${input.user.name}에게는 직접 질문하지 마세요(발언 안에서도, ask에서도). 사용자 의견이 꼭 필요하면 JSON에 "user_question": "사용자에게 듣고 싶은 것 한 문장"을 덧붙이세요. 사회자가 판단해서 대신 물어봅니다.` : ""}
[지금 차례] 전체 ${totalTurns}턴 중 ${turn}번째. ${phaseGuide(phase)}
사회자가 당신에게: "${request?.text || "의견 부탁드립니다."}"
${myTurn === 1 ? "주제와 자료를 보고 당신 관점에서 가장 중요한 한 가지부터 말하세요." : "지난 메모와 다른 사람 발언을 참고해, 이미 한 말은 반복하지 마세요."}`,
  });
  const utterance = String(out.utterance || "").trim() || "잠시 생각을 정리해 볼게요.";
  const stance = ["동의", "우려", "보류"].includes(out.stance) ? out.stance : "보류";
  const confidence = Math.max(0, Math.min(100, parseInt(out.confidence, 10) || 50));
  const position = String(out.position || "").replace(/^["'“‘]|["'”’]$/g, "").trim().slice(0, 30);
  const names = attendees.map((id) => PERSONAS[id]?.name).filter(Boolean);
  // 사용자에게 묻고 싶은 건 사회자에게 넘겨요 (ask.to에 사용자를 적었어도 마찬가지)
  const toUser = !!input.user?.name && out.ask?.to === input.user.name;
  const wantsUser = input.user?.name ? String((toUser ? out.ask?.question : "") || out.user_question || "").trim().slice(0, 200) : "";
  const ask = !toUser && out.ask?.to && MEMBER_NAMES.includes(out.ask.to) && names.includes(out.ask.to) && out.ask.to !== persona.name
    ? { to: out.ask.to, question: String(out.ask.question || "") } : null;
  const newState = {
    ...state, turns: myTurn,
    notes: clip(cleanNote(out.private_notes) || state.notes || "", 1200),
    said: [...(state.said || []), utterance].slice(-6),
    stances: [...(state.stances || []), { turn, stance, confidence, position }],
  };
  return { text: utterance, data: { stance, confidence, position, ask, wantsUser, phase, thoughts: newState.notes }, newState };
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
    user: `${agenda(input, 30000)}

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
  const notes = clip(cleanNote(out.private_notes) || state.notes || "", 1200);
  return { text: answer, data: { thoughts: cleanNote(out.private_notes) }, newState: { ...state, notes } };
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
  // 모델이 지원 종료되면 그 에이전트의 기본 모델 → FALLBACK_MODEL 순서로 대신 불러요
  const fallbacks = [defaultModelOf(persona), process.env.FALLBACK_MODEL || "google/gemini-3-flash-preview"];
  const llm = { apiKey, model, mock: !apiKey, fallbacks, onModel: (m) => { llm.model = m; } };

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
