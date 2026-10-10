// Ensembly (AI 회의실) · Copyright (c) 2026 박재현. All rights reserved. 무단 복제·수정·배포 금지 (LICENSE 참고)
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
import { isCheapModel, SHARED_MAX_OUT } from "./models.js";
import { chatJSON, resolveKey } from "./_lib/llm.js";
import { mockBaseline, mockFollowup, mockJudge, mockMember, mockModerate, mockSummary } from "./_lib/mock.js";
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
  siren: "경고등: 아무도 못 본 결정적인 위험을 처음 짚음 (레드팀이 제 몫을 했을 때)",
  scale: "균형추: 너무 빨리 모이던 합의에 반대편 논리를 세워 균형을 잡음",
  key: "해결사: 열린 반론을 근거로 가장 많이 정리(반박·수용)함",
  compass: "길잡이: 논점이 흐르거나 반복될 때 원래 질문으로 되돌림",
  link: "연결고리: 서로 다른 의견 사이의 공통점을 찾아 이어 줌",
  map: "설계자: 선택지·장단점·실행 계획을 가장 구체적으로 그림",
  ear: "경청왕: 실제로 영향받는 사람들의 입장을 가장 잘 대변함",
  rocket: "엉뚱한 상상: 아무도 생각 못 한 기발한 아이디어를 냄 (자유 토론·아이디어 회의에서)",
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
  reader: ["ear", "영향받는 사람들의 입장을 끝까지 대신 말해 줬어요."], method: ["key", "열린 반론을 근거로 차근차근 정리했어요."], policy: ["siren", "다들 놓친 되돌리기 기준의 공백을 처음 짚었어요."] };
const MOCK_BADGE_FREE = { critic: ["magnifier", "'그게 진짜 그럴까?' 한마디로 다들 생각을 한 번 뒤집어 보게 했어요."], strategist: ["bulb", "10년 뒤를 떠올리게 해서 이야기를 크게 넓혀 줬어요."],
  reader: ["handshake", "자기 경험을 솔직하게 꺼내서 분위기를 편하게 만들어 줬어요."], method: ["link", "서로 다른 말 사이의 공통점을 찾아 이어 줬어요."], policy: ["rocket", "'만약에'로 시작하는 엉뚱한 상상으로 대화를 넓혔어요."] };
// 사용자도 참석할 때 프롬프트에 넣는 소개
const userLine = (u) => (u?.name ? `${u.name}(사용자${u.title ? `, ${u.title}` : ""})` : "");
const userIntro = (u) => (u?.name ? `\n[사용자 참석] ${userLine(u)}도 이 회의에 함께합니다.${u.about ? ` 소개: ${String(u.about).slice(0, 300)}` : ""} 회의록에는 '${u.name}(사용자)'로 나옵니다.` : "");
// ── 회의 방식: 자료 검토(review) / 자유 토론(free) / 아이디어 회의(idea) ─────────────
// 자료 없이 생각을 나누는 회의에서 근거·숫자를 따지면 대화가 딱딱해져요. 방식에 따라 말하는 법과 라운드 성격을 바꿔요.
const styleOf = (input = {}) => (["free", "idea"].includes(input.style) ? input.style : "review");
const FREE_ROUNDS = [
  "다른 생각: 앞사람과 다르게 느끼는 지점을 편하게 말하는 차례입니다. 반박이라기보다 '저는 좀 다르게 느껴요'에 가깝게, 누구의 어떤 말에 대한 생각인지 짚으며 시작하세요.",
  "생각 더하기: 지금까지 나온 생각 중 하나를 골라 내 생각을 보태 키워 보는 차례입니다.",
  "상상해 보기: '만약에 ~라면?' 하고 상황을 하나 떠올려, 그때 어떨지 이야기하는 차례입니다.",
  "공통점 찾기: 다들 비슷하게 느낀 지점과 끝까지 다른 지점을 짚고, 내 생각을 한마디로 말하는 차례입니다.",
  "한 걸음 더: 오늘 이야기에서 해 볼 만한 것이나 더 생각해 볼 것을 하나 말하는 차례입니다.",
];
const IDEA_ROUNDS = [
  "아이디어 쏟기: 평가는 잠시 접고, 엉뚱해도 좋으니 새 아이디어를 하나 던지는 차례입니다.",
  "아이디어 키우기: 다른 사람 아이디어에 '좋아요, 그리고…'로 하나를 덧붙여 키우는 차례입니다. 깎아내리지 마세요.",
  "뒤집어 보기: 정반대로 하거나 전혀 다른 분야에서 빌려 오면 어떨지 떠올리는 차례입니다.",
  "고르기: 지금까지 나온 아이디어 중 가장 끌리는 것과 그 이유를 말하는 차례입니다.",
  "첫걸음: 고른 아이디어를 내일 당장 해 본다면 무엇부터 할지 말하는 차례입니다.",
];
const STYLE_GUIDE = {
  free: `[회의 방식: 자유 토론] 이번 회의는 자료 없이 각자의 생각을 자유롭게 나누는 자리입니다. 이 안내가 위의 역할 설명과 회의 규칙보다 우선합니다.
- 근거·데이터·출처·수치를 요구하거나 '확인된 게 뭐냐', '확인이 필요하다'고 말하지 마세요. 검증이나 팩트체크를 하는 자리가 아닙니다.
- 경험, 직관, 감정, 비유, 사례, '만약에' 같은 상상으로 말하세요. 확실하지 않은 건 '제 느낌엔', '저라면'처럼 말하면 됩니다.
- 앞사람 말을 받아서 이어 가세요('나래 님 말 들으니까…', '오, 그거 좋은데요. 거기에…'). 짧은 맞장구로 시작해도 좋습니다.
- 1~3문장, 매번 같은 길이일 필요는 없습니다. 보고서 말투 대신 동료들과 편하게 이야기하듯 말하세요.
- position은 평가가 아니라 지금 내 생각 한 줄입니다(예: '결국 사람 문제', '일단 해 보자', '낭만이 더 중요').`,
  idea: `[회의 방식: 아이디어 회의] 이번 회의는 아이디어를 내고 키우는 자리입니다. 이 안내가 위의 역할 설명과 회의 규칙보다 우선합니다.
- 근거·데이터·출처를 요구하지 마세요. 실현 가능성 따지기는 마지막에 잠깐만 합니다.
- '좋아요, 그리고…'처럼 남의 아이디어에 덧붙여 키우세요. 엉뚱하고 구체적인 아이디어일수록 좋습니다.
- 1~3문장, 편한 말투로. position은 지금 밀고 싶은 아이디어 한 줄입니다(예: '구독형으로 바꾸자', '게임처럼 만들기').`,
};
const STYLE_ROLE = {
  free: {
    critic: "자유 토론에서 당신은 숨은 전제를 찌르는 사람입니다. '근데 그게 진짜 그럴까요?', '반대로 생각해 보면요' 같은 질문으로 생각을 한 번 뒤집어 보게 합니다. 숫자나 출처는 묻지 않습니다. 말투는 짧고 직설적이되 장난기 있게.",
    strategist: "자유 토론에서 당신은 큰 그림을 그리고 미래를 상상하는 사람입니다. '10년 뒤엔요', '결국 이건 ~의 문제 같아요'처럼 생각을 넓힙니다.",
    reader: "자유 토론에서 당신은 감정과 경험을 이야기하는 사람입니다. '저라면 서운할 것 같아요', '제 주변 얘기인데요' 같은 생활 속 이야기를 합니다.",
    method: "자유 토론에서 당신은 서로 다른 의견 사이의 연결고리를 찾는 사람입니다. '두 분 말이 사실 같은 얘기 같아요'처럼 생각을 이어 줍니다.",
    policy: "자유 토론에서도 당신은 레드팀입니다. 다들 너무 쉽게 같은 생각으로 모이면 '정말 그럴까요?', '반대편은 이렇게 말할 거예요'처럼 다른 가능성을 꺼냅니다. 근거·데이터 대신 상상과 반대편의 시선으로 말합니다.",
  },
  idea: {
    critic: "아이디어 회의에서 당신은 아이디어를 더 날카롭게 다듬는 사람입니다. 약점을 짚을 때는 바로 고치는 방법을 함께 말합니다.",
    strategist: "아이디어 회의에서 당신은 흩어진 아이디어를 큰 방향으로 묶는 사람입니다.",
    reader: "아이디어 회의에서 당신은 실제로 쓰는 사람이 되어 아이디어를 상상해 보는 사람입니다.",
    method: "아이디어 회의에서 당신은 아이디어를 조합하고 구조를 잡는 사람입니다.",
    policy: "아이디어 회의에서 당신은 레드팀입니다. 모두가 좋아하는 아이디어의 가장 큰 약점을 짚고, 그 약점을 뒤집는 엉뚱한 대안을 함께 던집니다.",
  },
};
const MOD_STYLE = {
  free: "[회의 방식: 자유 토론] 근거·데이터를 묻지 말고 '혹시 비슷한 경험 있으세요?', '그 반대 상황이면 어때요?', '방금 그 말 더 듣고 싶어요'처럼 열린 질문으로 진행하세요. 쟁점을 정해 몰아가기보다 대화의 흐름을 이어 주는 역할입니다. 재미있는 갈래가 나오면 따라가세요. issue에는 지금 이야기하는 화제를 짧게 적습니다(예: '왜 끌리는가', '10년 뒤 모습'). say는 가볍고 따뜻하게.",
  idea: "[회의 방식: 아이디어 회의] 비판보다 아이디어를 끌어내세요. '그 아이디어에 하나 더 붙여 볼 분?', '완전히 반대로 하면요?'처럼 묻고, 좋은 아이디어가 나오면 다른 사람이 이어 키우게 하세요. issue에는 지금 키우는 아이디어를 짧게 적습니다. say는 가볍고 신나게.",
};
const styleBlock = (input, personaId) => { const st = styleOf(input); return st === "review" ? "" : `\n${STYLE_GUIDE[st]}\n${STYLE_ROLE[st][personaId] || ""}`; };

function phaseGuide(phase = "round1", style = "review") {
  if (phase === "round1") return style === "review" ? "1라운드: 사회자 개입 없이 한 사람씩 첫 의견을 말하는 차례입니다. 앞사람 이야기는 참고만 하고, 자기 관점의 핵심을 말하세요. 반박은 2라운드부터 합니다."
    : style === "idea" ? "1라운드: 사회자 개입 없이 한 사람씩 첫 아이디어를 하나씩 던지는 차례입니다." : "1라운드: 사회자 개입 없이 한 사람씩 이 주제에 대한 첫 생각을 편하게 말하는 차례입니다.";
  if (phase === "last_word") return style === "review" ? "최종 반론: 결론 전에 아직 가장 걸리는 점을 한 번 더 말하는 차례입니다. 양보할 것은 양보하고, 끝까지 짚고 싶은 한 가지를 분명히 하세요."
    : "마지막 한마디: 오늘 이야기 중 가장 마음에 남는 생각을 한두 문장으로 말하는 차례입니다.";
  if (String(phase).startsWith("more")) return "추가 토론: 사용자가 회의 뒤에 새 요청이나 자료를 줬습니다. [토론 주제]의 [추가 요청]과 [앞선 결론]을 보고, 새 요청을 중심으로 무엇이 바뀌거나 더해지는지 말하세요. 앞선 회의에서 한 말은 반복하지 마세요.";
  const n = parseInt(String(phase).replace("round", ""), 10) || 2;
  const R = style === "free" ? FREE_ROUNDS : style === "idea" ? IDEA_ROUNDS : ROUND_GUIDE;
  return `${n}라운드 · ${R[(n - 2) % R.length]}`;
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

// ── 긴 자료: 요약 카드 + 이번 쟁점에 맞는 구간만 ─────────────────────────
// 3만 6천 자(약 20쪽)까지는 지금처럼 자료 전체를 넣어요. 그보다 길면 회의 시작 때 만든 '자료 요약 카드'와
// 이번 발언에 필요한 구간만 골라 넣어서, 자료가 길어져도 발언마다 읽는 양은 비슷하게 유지돼요.
const FULL_DOC = 36000, CHUNK = 1500, PAGE_CHARS = 1800;
const chunkMemo = new Map();
function chunkDoc(text) {
  const src = String(text || ""), key = `${src.length}:${src.slice(0, 80)}:${src.slice(-80)}`;
  if (chunkMemo.has(key)) return chunkMemo.get(key);
  const paras = [], re = /\n\s*\n/g; let last = 0, m;
  while ((m = re.exec(src))) { paras.push({ t: src.slice(last, m.index), s: last }); last = m.index + m[0].length; }
  paras.push({ t: src.slice(last), s: last });
  const out = []; let cur = "", curStart = 0;
  const flush = () => { if (cur.trim()) out.push({ text: cur.trim(), start: curStart }); cur = ""; };
  for (const p of paras) {
    if (!p.t.trim()) continue;
    if (p.t.length > CHUNK * 1.6) {   // 아주 긴 문단은 잘라서 (바로 앞이 제목뿐이면 첫 조각에 붙여요)
      const lead = cur.length <= 300 ? cur : (flush(), ""); const leadStart = lead ? curStart : p.s; cur = "";
      for (let k = 0; k < p.t.length; k += CHUNK) out.push({ text: `${k === 0 && lead ? `${lead}\n\n` : ""}${p.t.slice(k, k + CHUNK)}`.trim(), start: k === 0 ? leadStart : p.s + k });
      continue;
    }
    const isHead = p.t.trim().length <= 60 && /^(\[첨부|[0-9]+(\.[0-9]+)*[.)]?\s|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|[□■○●▶◆①-⑳]|제\s?\d+\s?[장절조]|#)/.test(p.t.trim());
    // 크기가 넘치면 새 구간으로 (단, 지금 구간이 제목뿐이면 본문과 함께 두어요). 제목은 새 구간의 첫머리로
    if (cur && ((cur.length + p.t.length + 2 > CHUNK && cur.length > 300) || (isHead && cur.length > CHUNK * 0.3))) flush();
    if (!cur) curStart = p.s;
    cur += (cur ? "\n\n" : "") + p.t;
  }
  flush();
  const res = out.filter((c) => c.text).map((c, n) => ({ ...c, n: n + 1, page: Math.floor(c.start / PAGE_CHARS) + 1 }));
  if (chunkMemo.size > 20) chunkMemo.clear();
  chunkMemo.set(key, res);
  return res;
}
// 한글은 띄어쓰기·조사 때문에 단어보다 두 글자 묶음으로 비교하는 게 잘 맞아요
function grams(s) {
  const t = String(s || "").toLowerCase().replace(/[^0-9a-z가-힣]+/g, " ");
  const g = new Set();
  for (const w of t.split(" ")) { if (w.length === 1 && /[0-9a-z]/.test(w)) continue; if (w.length <= 2) { if (w) g.add(w); continue; } for (let i = 0; i < w.length - 1; i++) g.add(w.slice(i, i + 2)); }
  return g;
}
function pickChunks(text, query, k) {
  const chunks = chunkDoc(text); if (!chunks.length) return [];
  const q = grams(query); if (!q.size) return chunks.slice(0, k);
  const sets = chunks.map((c) => grams(c.text)), df = {};
  for (const s of sets) for (const g of s) if (q.has(g)) df[g] = (df[g] || 0) + 1;
  const N = chunks.length;
  const scored = chunks.map((c, i) => { let sc = 0; for (const g of q) if (sets[i].has(g)) sc += Math.log(1 + N / (df[g] || 1)); return { c, sc: sc / Math.sqrt(1 + sets[i].size / 400) }; });
  return scored.sort((a, b) => b.sc - a.sc).slice(0, k).map((x) => x.c).sort((a, b) => a.n - b.n);
}
// 반론 장부: 회의 중 제기된 반론과 상태(열림·반박·수용). 열린 것은 사회자·참석자 모두에게 보여 줘요
const ledgerText = (ledger = []) => {
  const open = (Array.isArray(ledger) ? ledger : []).filter((o) => o && o.status === "open").slice(0, 12);
  return open.length ? open.map((o) => `${o.id} (${o.by}): ${String(o.text).slice(0, 140)}${o.why ? ` — ${String(o.why).slice(0, 120)}` : ""}`).join("\n") : "(없음)";
};
const recentText = (transcript = [], n = 3) => transcript.slice(-n).map((t) => t.text).join(" ");

// 주제·자료 부분. stable은 회의 내내 같은 앞부분(캐시용), varying은 발언마다 바뀌는 구간
function agendaParts(input, limit, opt = {}) {
  const topic = String(input.topic || "").trim();
  const doc = input.document || {};
  if (doc.text && doc.text.length > FULL_DOC && doc.digest) {
    const picked = pickChunks(doc.text, `${topic} ${opt.query || ""}`, opt.k || 4);
    const N = chunkDoc(doc.text).length;
    const head = `[토론 주제]\n${topic || "(주제 문장 없음. 첨부 자료를 검토해 주세요.)"}\n\n[첨부 자료${doc.name ? `: ${doc.name}` : ""}] 전체 ${doc.text.length.toLocaleString()}자(약 ${Math.ceil(doc.text.length / PAGE_CHARS)}쪽), ${N}개 구간\n(자료가 길어서 '자료 요약 카드'와 이번 발언에 관련된 구간만 넣었어요. 넣지 않은 부분은 추측하지 말고 확인이 필요하다고 말하세요. 근거를 들 때는 <구간 번호>를 밝히세요.)\n\n[자료 요약 카드]\n${doc.digest}\n\n`;
    const body = `[이번 발언과 관련된 구간]\n${picked.map((c) => `<구간 ${c.n}/${N} · 약 ${c.page}쪽>\n${c.text}`).join("\n\n")}`;
    return { stable: head, varying: body, refs: picked.map((c) => ({ n: c.n, page: c.page })) };
  }
  return { stable: agenda(input, limit), varying: "", refs: [] };
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
    `[열린 반론] (반론 장부에서 아직 정리되지 않은 것. 답할 관점을 가진 사람에게 발언권을 줘 정리하게 하세요)\n${ledgerText(input.ledger)}`,
  ].filter(Boolean).join("\n");
  const A = agendaParts(input, 10000, { query: `${(state.issues || []).slice(-2).join(" ")} ${recentText(transcript, 3)}`, k: 2 });
  const out = llm.mock ? mockModerate({ transcript, phase, eligible: pool, hasDoc: !!document?.text, roundStart: input.roundStart, standing: input.standing || {}, style: styleOf(input) }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.4, maxTokens: 1200, cachePrefixLen: A.stable.length,
    user: `${A.stable}${A.varying}

[지금까지 회의록]
${transcriptText(transcript)}

[이번 회의 참석자] ${attendeeLine(attendees)}${input.user?.name ? `, ${userLine(input.user)}` : ""}${userIntro(input.user)}
[진행 상황] 전체 ${totalTurns}턴 중 ${turn}번째 발언 차례. ${phaseGuide(phase, styleOf(input))}${styleOf(input) === "review" ? "" : `\n${MOD_STYLE[styleOf(input)]}`}
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
  const A = agendaParts(input, 30000, { query: `${(state.issues || []).join(" ")} ${recentText(transcript, 12)}`, k: 8 });
  const review = llm.mock ? mockSummary({ document, topic: input.topic, style: styleOf(input) }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.3, maxTokens: 3500, cachePrefixLen: A.stable.length,
    user: `${A.stable}${A.varying}

[회의록]
${transcriptText(transcript)}

${when}${prevNote}
${styleOf(input) === "free" ? "이번 회의는 자유 토론이었습니다. 판정하지 마세요. verdict는 오늘 대화를 한마디로(10자 이내, 예: '생각이 모인 곳', '낭만 vs 현실', '의견이 다양함'), headline은 오늘 대화의 흐름을 한두 문장으로 씁니다. key_points에는 나온 생각들(detail에는 왜 그런지), concerns에는 엇갈린 시각, agreements에는 모두 비슷하게 느낀 점, open_questions에는 더 생각해 볼 질문을 담습니다. 근거나 데이터 부족을 지적하지 마세요. tone은 보통 mixed입니다."
  : styleOf(input) === "idea" ? "이번 회의는 아이디어 회의였습니다. verdict는 가장 끌린 아이디어를 짧게(10자 이내), headline은 고른 아이디어와 이유를 씁니다. key_points에는 고른 아이디어들(detail에는 해 보는 방법), concerns에는 다듬을 점, agreements에는 모두 끌린 점, open_questions에는 다음에 해 볼 것을 담습니다. tone은 보통 positive입니다."
  : "찬반 토론이면 모인 결론과 근거를, 아이디어 회의면 고른 아이디어와 실행 방법을, 자료 검토면 고칠 점과 제안을 key_points에 담습니다."}
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
  "options": [{"name": "선택지 이름 (예: A안 시범 도입)", "pros": ["장점"], "cons": ["단점"], "risks": ["위험"]}],
  "recommendation": "사회자 권고 한두 문장 (어느 선택지를 왜. 결정은 사용자가 합니다)",
  "decision_points": ["사용자가 직접 정해야 할 것"],
  "closing": "사회자 마무리 멘트 1~2문장",
  "private_notes": "사회자로서 회의를 마치며 드는 솔직한 생각 1~2문장 (머리말 없이)",
  "badges": [{"to": "받는 사람 이름", "badge": "배지 키", "reason": "왜 이 배지인지 사회자가 건네는 한 문장 (~해요 체)"}]
}
[결정 카드] 결정은 사용자가 합니다. options에는 회의에서 실제로 나온 선택지 2~3개를 장단점·위험과 함께 담고(자유 토론이면 생략해도 됩니다), recommendation은 권고일 뿐 결정이 아닙니다.
[열린 반론] 아래는 아직 정리되지 않은 반론입니다. 결론에서 지우지 말고 concerns나 open_questions에 '미해결'로 남기세요.
${ledgerText(input.ledger)}
[오늘의 배지] 사회자로서 참석자마다 회의에서 실제로 한 일에 맞는 배지를 1~2개 주세요. 근거 없이 주지 말고, 같은 배지를 여러 명에게 줘도 됩니다. 사회자 자신은 받지 않습니다.
참석자: ${(input.attendees || []).map((id) => PERSONAS[id]?.name).filter(Boolean).join(", ")}${input.user?.name && transcript.some((t) => t.role === "me") ? `, ${input.user.name}(사용자, 발언했다면 1개)` : ""}
배지 키: ${Object.entries(BADGE_GUIDE).map(([k, v]) => `${k}(${v})`).join(", ")}`,
  });
  if (!["positive", "mixed", "negative"].includes(review.tone)) review.tone = String(review.tone || "").match(/positive|negative/)?.[0] || "mixed";
  const thoughts = cleanNote(review.private_notes); delete review.private_notes;
  const names = [...(input.attendees || []).map((id) => PERSONAS[id]?.name).filter(Boolean), ...(input.user?.name && transcript.some((t) => t.role === "me") ? [input.user.name] : [])];
  review.badges = llm.mock
    ? [...(input.attendees || []).filter((id) => MOCK_BADGE[id]).map((id) => { const MB = styleOf(input) === "review" ? MOCK_BADGE : MOCK_BADGE_FREE; return { to: PERSONAS[id].name, badge: MB[id][0], reason: MB[id][1] }; }),
       ...(names.includes(input.user?.name) ? [{ to: input.user.name, badge: "talk", reason: "현장 이야기를 직접 들려줘서 토론이 훨씬 구체적이 됐어요." }] : [])]
    : pickBadges(review.badges, names);
  if (early) review.early = { doneTurns, totalTurns };
  review.style = styleOf(input);
  return {
    text: review.closing || "오늘 토론의 결론을 정리했습니다.",
    data: { thoughts },
    artifacts: [{ artifactId: uid(), name: "결론", parts: [{ data: review }] }],
    newState: { ...state, turns: state.turns + 1 },
  };
}

// ── 사회자: 긴 자료의 요약 카드 (회의 시작 때 한 번) ─────────────────────
function extractiveDigest(text) {   // 모델 없이도 만드는 간단한 카드 (모의 모드·실패 대비)
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const heads = lines.filter((l) => l.length <= 60 && /^(\[첨부|[0-9]+[.)]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.)]?|[□■○●◦▶◇◆①-⑳가-하][.)]?\s|제\s?\d+\s?[장절조])/.test(l)).slice(0, 14);
  const nums = lines.filter((l) => /\d[\d,.]*\s?(%|명|원|건|개|억|만|천|배|p|%p|개소|년)/.test(l) && l.length <= 140).slice(0, 8);
  return [`목차(추정): ${heads.length ? heads.join(" / ") : "(뚜렷한 제목 없음)"}`, nums.length ? `주요 수치: ${nums.join(" / ")}` : ""].filter(Boolean).join("\n").slice(0, 3000);
}
async function makeDigest(llm, persona, input, state) {
  const doc = input.document || {};
  if (!doc.text) return { text: "자료가 없어요.", data: { digest: "" }, newState: state };
  let digest = "";
  if (!llm.mock) {
    try {
      const src = clipDoc(doc.text, 60000);
      const out = await chatJSON({
        ...llm, system: "당신은 회의 자료를 정리하는 담당자입니다. 여러 사람이 이 자료로 토론하면서 다시 찾아볼 수 있게, 사실만 정확하게 정리합니다. 자료에 없는 내용은 쓰지 않습니다.", temperature: 0.2, maxTokens: 1800,
        user: `[자료${doc.name ? `: ${doc.name}` : ""}] 전체 ${doc.text.length.toLocaleString()}자${src.cut ? " (길어서 앞부분과 뒤쪽 여러 군데를 발췌)" : ""}\n${src.text}\n\n이 자료의 요약 카드를 만드세요. JSON 하나만 출력합니다.\n{"outline": ["장·절 제목과 한 줄 요약 (최대 12개)"], "key_points": ["핵심 주장이나 결론 (최대 8개)"], "numbers": ["핵심 수치와 기준(단위·시점) (최대 10개)"], "issues": ["토론할 만한 쟁점 (최대 6개)"]}`,
      });
      const L = (k, t) => (Array.isArray(out?.[k]) && out[k].length ? `${t}\n${out[k].slice(0, 12).map((x) => `- ${String(x).slice(0, 200)}`).join("\n")}` : "");
      digest = [L("outline", "■ 목차"), L("key_points", "■ 핵심 내용"), L("numbers", "■ 주요 수치"), L("issues", "■ 쟁점 후보")].filter(Boolean).join("\n").slice(0, 4000);
    } catch { digest = ""; }
  }
  if (!digest) digest = extractiveDigest(doc.text);
  return { text: "자료 요약 카드를 만들었어요.", data: { digest }, newState: state };
}

// ── 단일 LLM 비교 실험 ─────────────────────────────────────────────────
// 같은 의제·같은 자료로, 잘 짠 프롬프트 한 번에 단일 AI가 결론까지 내게 해요 (회의와 같은 결론 형식)
const REVIEW_SCHEMA = `{"verdict": "판정 10자 이내", "tone": "positive" | "mixed" | "negative", "headline": "결론 한두 문장",
  "key_points": [{"title": "핵심 결론이나 제안", "detail": "근거나 방법"}], "concerns": [{"title": "우려나 반대 의견", "detail": "보완 방법"}],
  "agreements": ["합의할 만한 점"], "open_questions": ["남은 질문"],
  "options": [{"name": "선택지", "pros": ["장점"], "cons": ["단점"], "risks": ["위험"]}], "recommendation": "권고", "decision_points": ["사용자가 정할 것"]}`;
async function baseline(llm, persona, input, state) {
  const A = agendaParts(input, 36000, { query: input.topic || "", k: 8 });
  const review = llm.mock ? mockBaseline({ topic: input.topic }) : await chatJSON({
    ...llm, temperature: 0.4, maxTokens: 3500, cachePrefixLen: A.stable.length,
    system: "당신은 혼자서 의사결정 검토 결과를 만드는 AI입니다. 근거 검증, 전략, 영향받는 사람, 논리, 위험(레드팀) 관점을 모두 스스로 고려해 균형 있게 검토합니다.",
    user: `${A.stable}${A.varying}\n\n위 주제를 여러 관점에서 검토해 결론을 내세요. 서로 다른 관점, 반론과 위험, 선택지와 장단점, 남은 질문을 빠짐없이 담으세요.\nJSON 하나만 출력합니다.\n${REVIEW_SCHEMA}`,
  });
  return { text: "단일 AI 결과를 만들었어요.", data: { review }, newState: state };
}
const JUDGE_CRITERIA = ["관점 다양성", "비판·위험 발견", "의사결정 완성도", "논점 집중", "실행 가능성"];
async function judge(llm, persona, input, state) {
  const show = (r) => JSON.stringify({ verdict: r?.verdict, headline: r?.headline, key_points: r?.key_points, concerns: r?.concerns, agreements: r?.agreements, open_questions: r?.open_questions, options: r?.options, recommendation: r?.recommendation }).slice(0, 9000);
  const out = llm.mock ? mockJudge(input.a, input.b) : await chatJSON({
    ...llm, temperature: 0.1, maxTokens: 1500,
    system: "당신은 의사결정 검토 결과물을 공정하게 채점하는 평가자입니다. 어느 쪽이 어떤 방식으로 만들어졌는지 모릅니다. 길이나 말투가 아니라 내용만 봅니다.",
    user: `[주제]\n${String(input.topic || "").slice(0, 1500)}\n\n[결과 A]\n${show(input.a)}\n\n[결과 B]\n${show(input.b)}\n\n아래 기준마다 A와 B를 1~5점으로 채점하고 이유를 한 문장씩 쓰세요. 기준: ${JUDGE_CRITERIA.join(", ")}.\nJSON 하나만 출력합니다.\n{"scores": [{"criterion": "기준 이름", "a": 1~5, "b": 1~5, "why": "한 문장"}], "better": "A" | "B" | "비슷", "summary": "전체 평가 한두 문장"}`,
  });
  const scores = JUDGE_CRITERIA.map((c) => { const x = (out.scores || []).find((y) => y?.criterion === c) || {}; const n = (v) => Math.max(1, Math.min(5, parseInt(v, 10) || 3)); return { criterion: c, a: n(x.a), b: n(x.b), why: String(x.why || "").slice(0, 200) }; });
  return { text: "채점을 마쳤어요.", data: { scores, better: ["A", "B", "비슷"].includes(out.better) ? out.better : "비슷", summary: String(out.summary || "").slice(0, 400) }, newState: state };
}

// ── 참석자: 발언 ─────────────────────────────────────────────────────
async function reviewTurn(llm, persona, input, state) {
  const { document, transcript = [], request, turn = 1, totalTurns = 12, phase = "round1", attendees = MEMBER_IDS } = input;
  const myTurn = (state.turns || 0) + 1;
  const A = agendaParts(input, 36000, { query: `${input.issue || ""} ${request?.text || ""} ${recentText(transcript, 3)}`, k: persona.id === "critic" ? 7 : 4 });
  const out = llm.mock ? mockMember(persona.id, { document, myTurn, phase, topic: input.topic, style: styleOf(input), ledger: input.ledger || [] }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.8, maxTokens: 2500, cachePrefixLen: A.stable.length,
    user: `${A.stable}${A.varying}

[지금까지 회의록]
${transcriptText(transcript)}

[당신의 지난 속마음 (다른 참석자에게는 전달되지 않음)]
${state.notes || "(아직 없음)"}

[이번 회의 참석자] ${attendeeLine(attendees)}${input.user?.name ? `, ${userLine(input.user)}` : ""}${userIntro(input.user)}${input.user?.name ? `\n사용자 ${input.user.name}에게는 직접 질문하지 마세요(발언 안에서도, ask에서도). 사용자 의견이 꼭 필요하면 JSON에 "user_question": "사용자에게 듣고 싶은 것 한 문장"을 덧붙이세요. 사회자가 판단해서 대신 물어봅니다.` : ""}
[열린 반론]\n${ledgerText(input.ledger)}
[당신의 지난 입장] ${(state.stances || []).at(-1) ? `${state.stances.at(-1).position || ""} (${state.stances.at(-1).stance}, 확신 ${state.stances.at(-1).confidence}%)` : "(첫 발언)"}
[지금 차례] 전체 ${totalTurns}턴 중 ${turn}번째. ${phaseGuide(phase, styleOf(input))}${styleBlock(input, persona.id)}
사회자가 당신에게: "${request?.text || "의견 부탁드립니다."}"
${myTurn === 1 ? (styleOf(input) === "review" ? "주제와 자료를 보고 당신 관점에서 가장 중요한 한 가지부터 말하세요." : "주제를 듣고 가장 먼저 떠오른 생각을 편하게 말하세요.") : "지난 메모와 다른 사람 발언을 참고해, 이미 한 말은 반복하지 마세요."}`,
  });
  const utterance = String(out.utterance || "").trim() || "잠시 생각을 정리해 볼게요.";
  let stance = ["동의", "우려", "보류"].includes(out.stance) ? out.stance : "보류";
  let confidence = Math.max(0, Math.min(100, parseInt(out.confidence, 10) || 50));
  // 동조 방지: 입장이나 확신(20%p 넘게)을 바꾸려면 누구의 어떤 근거 때문인지 있어야 해요. 없으면 바꾼 것으로 치지 않아요
  const prevStance = (state.stances || []).at(-1);
  const changedBecause = String(out.changed_because || "").trim().slice(0, 200);
  const shifted = prevStance && (stance !== prevStance.stance || Math.abs(confidence - prevStance.confidence) > 20);
  let unjustified = false;
  if (shifted && changedBecause.length < 8) { stance = prevStance.stance; confidence = prevStance.confidence; unjustified = true; }
  // 레드팀은 자기가 낸 반론이 열려 있는 동안 '동의'로 돌아서지 않아요
  const ledger = Array.isArray(input.ledger) ? input.ledger : [];
  const redTeamBlocked = persona.id === "policy" && stance === "동의" && ledger.some((o) => o.status === "open" && o.by === persona.name);
  if (redTeamBlocked) stance = "우려";
  const objections = (Array.isArray(out.objections) ? out.objections : []).map((o) => ({ text: String(o?.text || "").trim().slice(0, 140), why: String(o?.why || "").trim().slice(0, 180) }))
    .filter((o) => o.text.length >= 6).slice(0, persona.id === "policy" ? 3 : 2);
  const openIds = new Set(ledger.filter((o) => o.status === "open").map((o) => o.id));
  const resolves = (Array.isArray(out.resolves) ? out.resolves : []).map((r) => ({ id: String(r?.id || "").trim().toUpperCase(), how: r?.how === "수용" ? "수용" : "반박", why: String(r?.why || "").trim().slice(0, 180) }))
    .filter((r) => openIds.has(r.id) && r.why.length >= 4).slice(0, 3);
  const criterion = String(out.criterion || "").trim().slice(0, 16);
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
  return { text: utterance, data: { stance, confidence, position, ask, wantsUser, phase, refs: A.refs, thoughts: newState.notes,
    criterion, changedBecause: shifted && !unjustified ? changedBecause : "", unjustified, redTeamBlocked, objections, resolves }, newState };
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
  const A = agendaParts(input, 30000, { query: `${question} ${recentText(thread.map((t) => ({ text: t.question })), 2)}`, k: 5 });
  const out = llm.mock ? mockFollowup(persona.id, { question, review }) : await chatJSON({
    ...llm, system: persona.system, temperature: 0.6, maxTokens: 1800, cachePrefixLen: A.stable.length,
    user: `${A.stable}${A.varying}

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
${styleOf(input) === "review" ? "" : "근거나 데이터를 따지지 말고 편하게 이야기하듯 답하세요. "}회의 발언 형식은 잊고 질문에 바로 답하세요. 3~6문장, 필요하면 근거가 된 자료 위치를 짚고, 모르는 것은 모른다고 말하세요.
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

// 공통 대체 모델 (쉼표로 여러 개). 기본: Gemini → GPT → Claude 순서로 회사를 섞어요. 중국 계열은 넣지 않아요
const FALLBACK_MODELS = () => (process.env.FALLBACK_MODELS || process.env.FALLBACK_MODEL || "google/gemini-3.8-flash,openai/gpt-6-luna,anthropic/claude-haiku-5.5")
  .split(",").map((x) => x.trim()).filter(Boolean);

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
  // 내 키: 어떤 허용 모델이든 고를 수 있어요. 공용 키: 저렴한 모델(출력 100만 토큰당 SHARED_MAX_OUT_PRICE달러 이하)만 고를 수 있어요.
  const wanted = String(req.headers["x-agent-model"] || "").trim();
  if (wanted && !isAllowedModel(wanted)) {
    return rpcError(res, body.id, -32602, `허용되지 않은 모델이에요: ${wanted}`);
  }
  const sharedPick = !userKey && apiKey && wanted && wanted !== sharedModelOf(persona);
  if (sharedPick && !(await isCheapModel(wanted))) {
    return rpcError(res, body.id, -32602, `공용 키로는 출력 100만 토큰당 $${SHARED_MAX_OUT()} 이하 모델만 고를 수 있어요(${wanted}). 더 좋은 모델은 내 API 키로 써 주세요.`);
  }
  // 내 키: 고른 모델(없으면 기본 모델). 공용 키: 고른 저렴한 모델(없으면 운영자가 정한 가벼운 모델).
  const model = userKey ? (wanted || defaultModelOf(persona)) : apiKey ? (wanted || sharedModelOf(persona)) : defaultModelOf(persona);
  // 모델이 지원 종료되면 그 에이전트의 기본 모델 → FALLBACK_MODEL 순서로 대신 불러요
  // 대체 모델 순서: 이 에이전트의 기본 모델 → 공통 대체 모델들(회사를 섞어 둬서 한 회사가 막혀도 이어져요). 공용 키는 비싼 기본 모델로 넘어가지 않게
  const fallbacks = [userKey || !apiKey ? defaultModelOf(persona) : sharedModelOf(persona), ...FALLBACK_MODELS()];
  const usage = { in: 0, out: 0, cost: 0 };
  const llm = { apiKey, model, mock: !apiKey, fallbacks, onModel: (m) => { llm.model = m; }, onUsage: (u) => { usage.in += u.in; usage.out += u.out; usage.cost += u.cost; },
    onFallback: (f) => { llm.fallback = f; } };

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
    else if (isMod && input.type === "digest") r = await makeDigest(llm, persona, input, state);
    else if (isMod && input.type === "baseline") r = await baseline(llm, persona, input, state);
    else if (isMod && input.type === "judge") r = await judge(llm, persona, input, state);
    else if (!isMod && input.type === "review_turn") r = await reviewTurn(llm, persona, input, state);
    else if (input.type === "followup") r = await followup(llm, persona, input, state);
    else return rpcError(res, body.id, -32602, `${persona.name}은(는) '${input.type}' 요청을 처리하지 않아요.`);

    const result = taskResult(ctx, {
      text: r.text, data: { ...r.data, model: llm.mock ? "mock" : llm.model, usage, ...(llm.fallback ? { fallbackFrom: llm.fallback.from, fallbackWhy: llm.fallback.reason } : {}) },
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
