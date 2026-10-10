// Ensembly (AI 회의실) · Copyright (c) 2026 박재현. All rights reserved. 무단 복제·수정·배포 금지 (LICENSE 참고)
// API 키 없이 흐름을 연습할 수 있는 모의 응답. 첨부 자료가 있으면 자료 속 문장을, 없으면 토론 주제를 인용해 그럴듯하게 말합니다.
import { MEMBER_IDS, PERSONAS } from "./personas.js";

function facts(text) {
  const parts = (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.다음함])\s+|[□○▪■※]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 160);
  const withNum = parts.filter((s) => /\d/.test(s));
  return withNum.length ? withNum : parts.length ? parts : ["자료 첫 부분"];
}
const cut = (s, n = 36) => (s.length > n ? s.slice(0, n) + "…" : s);
const NAME = (id) => PERSONAS[id].name;

const MOCK_ISSUES = { round1: "첫 의견", round2: "근거와 반론", round3: "대안", round4: "입장 바꿔 보기", round5: "합의점", round6: "실행 순서", last_word: "남은 걱정" };
const MOCK_ISSUES_FREE = { round1: "첫 생각", round2: "서로 다른 느낌", round3: "생각 더하기", round4: "만약에", round5: "공통점", round6: "해 볼 만한 것", last_word: "마음에 남는 것" };
export function mockModerate({ transcript, phase, eligible, hasDoc = true, roundStart = false, standing = {}, style = "review" }) {
  const last = [...transcript].reverse().find((t) => t.role !== "moderator");
  // 모의 모드도 순서를 돌리지 않게: 덜 말한 사람 중에서 직전 발언자와 시각이 다른 사람을 먼저
  const talks = (id) => transcript.filter((t) => t.role === id).length;
  const least = Math.min(...eligible.map(talks));
  const pool = eligible.filter((id) => talks(id) <= least + (phase === "round1" ? 0 : 1));
  const differ = pool.filter((id) => standing[id]?.stance && standing[id].stance !== standing[last?.role]?.stance);
  const from = differ.length ? differ : pool.length ? pool : eligible;
  let next = from[Math.floor(Math.random() * from.length)];
  const free = style !== "review";
  const issue = (free ? MOCK_ISSUES_FREE : MOCK_ISSUES)[phase] || "추가 쟁점";
  const asked = last?.ask?.to && Object.values(PERSONAS).find((p) => p.name === last.ask.to)?.id;
  if (asked && eligible.includes(asked)) next = asked;
  const intro = roundStart && transcript.length && phase !== "round1" ? (free ? `다들 생각이 조금씩 다르네요. 이번엔 '${issue}' 얘기를 해 볼까요? ` : `지금까지 근거와 걱정이 함께 나왔어요. 이번엔 '${issue}'을 중심으로 이야기해 볼게요. `) : "";
  const say = intro + (phase === "last_word"
    ? `결론 내기 전에, ${NAME(next)} 님이 아직 가장 걸리는 부분을 한 번 더 말씀해 주세요.`
    : transcript.length === 0
      ? `${hasDoc ? "자료" : "주제"} 잘 받았습니다. ${NAME(next)} 님부터 첫 의견 부탁드려요.`
      : asked === next
        ? `${NAME(next)} 님, 방금 질문에 답해 주시겠어요?`
        : phase !== "round1"
          ? (free ? `${NAME(next)} 님은 방금 얘기 들으면서 어떤 생각 드셨어요?` : `${NAME(next)} 님, 앞선 의견 중 동의하기 어려운 게 있으면 짚어 주세요.`)
          : `${NAME(next)} 님은 어떻게 보셨어요?`);
  return { next, say, issue, reason: asked === next ? `${NAME(next)} 님이 질문을 받았으니 바로 답하게 함` : `아직 이번 라운드에 말하지 않은 ${NAME(next)} 님 차례` };
}

const LINES = {   // 첨부 자료가 있을 때의 대사 (자료 속 문장 a, b를 인용)
  critic: [
    (a) => `"${a}" 여기부터 걸려요. 이 주장의 근거가 자료 어디에 있는지, 숫자라면 계산이 맞는지 다시 봐야 합니다.`,
    (a, b) => `나래 님 말씀은 알겠는데, 사실관계부터 맞추고요. "${b}" 부분은 출처와 기준을 한 번 더 확인해야 해요.`,
  ],
  strategist: [
    (a) => `민서 님이 근거는 잘 보실 테니, 저는 핵심을 볼게요. 이 자료가 말하려는 건 "${a}" 쪽인데 그게 잘 안 드러나요.`,
    (a, b) => `정리하면 사실 확인은 민서 님 의견대로 하고, 핵심 메시지는 맨 앞으로 끌어올리는 게 좋겠어요.`,
  ],
  reader: [
    (a) => `솔직히 저는 "${a}" 이 문장 두 번 읽었어요. 처음 보는 사람은 오해할 수 있을 것 같아요.`,
    (a, b) => `나래 님 방향에 동의해요. 다만 "${b}" 부분은 예시를 하나 붙이면 훨씬 쉽게 읽힐 거예요.`,
  ],
  method: [
    (a) => `"${a}" 이 부분은 조건이 하나 붙어야 해요. 무엇을 기준으로 비교했는지 밝혀 두는 게 맞습니다.`,
    (a, b) => `민서 님 지적에 이유를 보태면, "${b}"는 일부 사례에서 나온 이야기라 단정적인 표현은 피하는 게 좋겠어요.`,
  ],
  policy: [
    (a) => `이거 반대하는 사람은 뭐라고 할까요? "${a}" 문장은 받아들이는 사람에 따라 불편하게 읽힐 수 있어요.`,
    (a, b) => `도윤 님 말대로 쉽게 쓰는 건 좋은데, 민감한 부분은 미리 반대 의견을 들어 보고 표현을 다듬는 게 안전합니다.`,
  ],
};

// 자료 없이 주제만 있을 때의 대사
const TOPIC_LINES = {
  critic: [
    (t) => `"${t}" 이야기라면 저는 근거부터 묻고 싶어요. 지금까지 나온 주장 중에 숫자로 확인된 게 뭐가 있죠?`,
    () => `나래 님 방향은 좋은데, 사실관계부터 맞추고요. 효과가 있다는 근거가 어디서 나온 건지 분명히 해야 해요.`,
  ],
  strategist: [
    (t) => `핵심은 "${t}"에서 우리가 진짜 얻고 싶은 게 뭐냐는 거예요. 목표부터 한 문장으로 정하면 논의가 빨라질 거예요.`,
    () => `정리하면, 작게 시범으로 해 보고 결과를 본 다음 넓히는 쪽이 현실적이에요.`,
  ],
  reader: [
    (t) => `솔직히 보통 사람 입장에서는 "${t}"가 내 생활에 뭐가 달라지는지부터 궁금할 것 같아요.`,
    () => `나래 님 말에 동의해요. 다만 설명을 쉽게 해야 오해가 안 생겨요.`,
  ],
  method: [
    (t) => `"${t}"는 조건이 하나 붙어야 해요. 무엇을 기준으로 성공이라고 볼지 먼저 정의해야 비교가 공정해요.`,
    () => `민서 님 지적에 보태면, 다른 사례에서 효과가 있었다고 여기서도 같을 거라고 단정하면 안 돼요.`,
  ],
  policy: [
    (t) => `이거 실제로 하면 누가 제일 반대할 것 같아요? "${t}"는 이해관계가 꽤 갈릴 거예요.`,
    () => `도윤 님 말대로 설명은 쉬워야 하고, 반대편 말을 미리 듣고 보완책을 준비해 두는 게 안전해요.`,
  ],
};

const FREE_LINES = {   // 자유 토론·아이디어 회의 (근거·숫자 대신 경험, 직관, 상상)
  critic: [(t) => `근데 "${t}", 그게 진짜 그럴까요? 반대로 생각해 보면 오히려 지금이 나은 사람도 있을 것 같아요.`, () => `오, 그 말 들으니 좀 흔들리네요. 그래도 저는 결국 '누구를 위한 거냐'가 남는 것 같아요.`],
  strategist: [(t) => `저는 "${t}"를 들으니 10년 뒤 모습부터 떠올라요. 결국 이건 일하는 방식이 바뀌는 문제 같아요.`, () => `민서 님 말에 하나 보태면, 처음부터 정답을 찾기보다 작게 해 보면서 배우는 게 맞는 것 같아요.`],
  reader: [(t) => `저라면 "${t}" 얘기 들으면 일단 설렐 것 같아요. 근데 주변에 서운해할 사람도 떠오르긴 해요.`, () => `저도 비슷해요. 제 주변만 봐도 반기는 사람과 불안해하는 사람이 반반이에요.`],
  method: [(t) => `"${t}"에 대해 두 가지 마음이 같이 드는 것 같아요. 기대랑 걱정이 사실 같은 뿌리인 것 같기도 하고요.`, () => `두 분 말이 사실 같은 얘기 같아요. 결국 '선택할 수 있느냐'가 핵심인 것 같아요.`],
  policy: [(t) => `만약에 "${t}"가 내일 당장 이뤄진다면요? 저는 첫 주엔 신나다가 둘째 주에 혼란스러울 것 같아요.`, () => `하나 상상해 보면, 다 같이 하는 대신 원하는 사람만 해 보면 어떨까요? 생각보다 재밌을 것 같아요.`],
};
const MOCK_CRITERION = { critic: "근거의 정확성", strategist: "목표 적합성", reader: "사람들의 체감", method: "비교의 공정성", policy: "미해결 위험" };
const MOCK_OBJ = [
  { text: "반대하는 이해관계자의 입장이 아직 검토되지 않았어요", why: "실행 단계에서 반발로 일정이 밀릴 수 있어요" },
  { text: "실패했을 때 되돌리는 방법이 없어요", why: "시범이 실패하면 원래대로 돌아갈 기준이 필요해요" },
  { text: "비용 추정이 빠져 있어요", why: "예산 없이 결정하면 나중에 범위를 줄여야 해요" },
  { text: "성과를 무엇으로 볼지 합의가 없어요", why: "기준이 없으면 결과를 두고 다시 다투게 돼요" },
];
export function mockMember(personaId, args) {
  const base = mockMemberBase(personaId, args);
  const { phase, myTurn, ledger = [] } = args;
  const open = ledger.filter((o) => o.status === "open");
  const out = { ...base, criterion: MOCK_CRITERION[personaId] || "", changed_because: "", objections: [], resolves: [] };
  // 레드팀은 매번 반론을 하나씩, 검증가는 첫 발언에 하나
  if (personaId === "policy") out.objections = [MOCK_OBJ[(myTurn - 1) % MOCK_OBJ.length]];
  if (personaId === "critic" && phase === "round1") out.objections = [MOCK_OBJ[3]];
  // 2라운드부터 전략가·논리 점검가가 열린 반론을 하나씩 정리
  if (phase !== "round1" && ["strategist", "method", "reader"].includes(personaId) && open.length) {
    const o = open.find((x) => x.by !== "하율") || open[0];
    out.resolves = [{ id: o.id, how: personaId === "reader" ? "수용" : "반박", why: personaId === "reader" ? "그 걱정을 받아들여 설명과 보완책을 넣기로 해요" : "시범 범위를 작게 잡으면 그 위험은 관리할 수 있어요" }];
  }
  if (phase !== "round1" && base.stance !== "보류") out.changed_because = personaId === "policy" ? "" : "앞선 발언에서 시범 범위를 줄이자는 근거를 듣고 생각이 바뀌었어요";
  return out;
}
function mockMemberBase(personaId, { document, myTurn, phase, topic, style = "review" }) {
  if (style !== "review") {
    const i = phase === "round1" ? 0 : 1;
    return {
      utterance: FREE_LINES[personaId][i](cut(String(topic || "이 주제").split("\n\n[")[0].trim(), 30)),
      stance: phase === "round1" ? "보류" : personaId === "critic" ? "우려" : "동의",
      confidence: phase === "round1" ? 55 : 70,
      position: (phase === "round1"
        ? { critic: "정말 그럴까?", strategist: "일하는 방식의 문제", reader: "설렘 반 걱정 반", method: "기대와 걱정은 한 뿌리", policy: "첫 주는 신날 듯" }
        : { critic: "누구를 위한 건지", strategist: "작게 해 보며 배우기", reader: "반기는 사람 반반", method: "선택할 수 있느냐", policy: "원하는 사람만 해 보기" })[personaId],
      ask: { to: null, question: "" },
      private_notes: phase === "round1" ? "다들 생각이 다르니 재밌다. 다른 사람 얘기를 더 들어 보자." : "생각이 조금씩 모이는 것 같다. 끝까지 내 느낌은 지키고 싶다.",
    };
  }
  if (!document?.text) {
    const i = phase === "round1" ? 0 : 1;
    return {
      utterance: TOPIC_LINES[personaId][i](cut(String(topic || "이 주제").split("\n\n[")[0].trim(), 30)),
      stance: phase === "round1" ? "보류" : personaId === "policy" ? "우려" : "동의",
      confidence: phase === "round1" ? 50 : personaId === "policy" ? 75 : 70,
      position: (phase === "round1"
        ? { critic: "근거부터 확인", strategist: "목표부터 정하자", reader: "생활 변화가 궁금", method: "성공 기준부터", policy: "이해관계가 갈림" }
        : { critic: "시범 도입부터", strategist: "작게 시작해 넓히기", reader: "쉽게 설명하면 찬성", method: "조건부로 가능", policy: "반발 대책이 먼저" })[personaId],
      ask: phase === "round1" && personaId === "critic" ? { to: "나래", question: "목표를 숫자로 말하면 뭐예요?" } : { to: null, question: "" },
      private_notes: phase === "round1" ? "아직 판단하기엔 이르다. 다른 사람 생각부터 들어 보자." : "방향은 모였다. 실행 조건만 분명하면 찬성할 수 있다.",
    };
  }
  const f = facts(document?.text);
  const k = MEMBER_IDS.indexOf(personaId) + myTurn * 2;
  const a = cut(f[k % f.length]);
  const b = cut(f[(k + 3) % f.length]);
  const i = phase === "round1" ? 0 : 1;  // 2라운드 이후와 최종 반론은 두 번째 대사
  const ask = phase === "round1" && personaId === "critic" ? { to: "나래", question: "이 내용을 핵심으로 내세워도 될 만큼 근거가 충분할까요?" }
            : phase === "round1" && personaId === "reader" ? { to: "현우", question: "이 용어, 짧은 설명만 붙이면 충분할까요?" }
            : { to: null, question: "" };
  return {
    utterance: LINES[personaId][i](a, b),
    stance: phase === "round1" ? "우려" : personaId === "policy" ? "우려" : "동의",
    confidence: phase === "round1" ? 40 + k * 3 : 60 + k * 2,
    position: (phase === "round1"
      ? { critic: "근거 보강 필요", strategist: "핵심이 안 보임", reader: "용어가 어려움", method: "비교 기준 불분명", policy: "오해 소지 있음" }
      : { critic: "출처 달면 가능", strategist: "핵심을 앞으로", reader: "예시 붙이면 OK", method: "단정 표현만 빼면", policy: "표현부터 다듬기" })[personaId],
    ask,
    private_notes: phase === "round1"
      ? `첫인상으로는 고칠 게 꽤 보인다. 다음엔 "${b}" 부분을 더 봐야겠다.`
      : `다른 분들 의견으로 많이 정리됐다. 그래도 "${a}" 부분은 끝까지 짚고 넘어가고 싶다.`,
  };
}

export function mockSummary({ document, topic, style = "review" }) {
  if (style !== "review") {
    const t = cut(String(topic || "이 주제").split("\n\n[")[0].trim(), 30);
    return {
      verdict: style === "idea" ? "원하는 사람만 해 보기" : "설렘 반 걱정 반", tone: style === "idea" ? "positive" : "mixed",
      headline: `"${t}"를 두고 기대와 걱정이 함께 나왔고, 결국 '선택할 수 있느냐'가 핵심이라는 데 생각이 모였어요.`,
      key_points: [
        { title: "결국 일하는 방식이 바뀌는 문제", detail: "10년 뒤를 생각하면 지금의 고민이 다르게 보여요", raised_by: "나래" },
        { title: "기대와 걱정은 같은 뿌리", detail: "'선택할 수 있느냐'에 따라 마음이 갈려요", raised_by: "현우" },
        { title: "원하는 사람만 먼저 해 보기", detail: "다 같이보다 부담이 적고 재밌을 수 있어요", raised_by: "하율" },
      ],
      concerns: [{ title: "누구를 위한 변화인지", detail: "반기는 사람과 불안한 사람이 함께 있어요", raised_by: "민서" }],
      agreements: ["처음부터 정답을 찾기보다 작게 해 보며 배우자", "사람마다 느끼는 게 다르다는 걸 인정하자"],
      open_questions: ["원하는 사람만 해 볼 때 나머지 사람은 어떻게 느낄까?"],
      options: style === "idea" ? [{ name: "원하는 사람만 먼저 해 보기", pros: ["부담이 적어요"], cons: ["참여가 적을 수 있어요"], risks: ["안 하는 사람이 소외될 수 있어요"] }] : [],
      recommendation: "", decision_points: ["원하는 사람만 해 볼 때 기준을 어떻게 정할지"],
      closing: "(모의 모드) 오늘 이야기 재밌었어요. 생각이 더 나면 다음에 또 이어 가요.",
      private_notes: "근거 따지지 않으니 오히려 솔직한 얘기가 많이 나왔다.",
    };
  }
  if (!document?.text) {
    const t = cut(String(topic || "이 주제").split("\n\n[")[0].trim(), 30);
    return {
      verdict: "조건부 합의", tone: "mixed",
      headline: `"${t}"에 대체로 찬성하지만, 목표와 성공 기준을 먼저 정하고 작게 시범으로 시작하자는 결론이에요.`,
      key_points: [
        { title: "목표를 한 문장으로 먼저 정하기", detail: "무엇을 얻으려는지 정하면 우선순위가 정리돼요", raised_by: "나래" },
        { title: "성공 기준을 숫자로 정의하기", detail: "시작 전에 비교 기준을 정해 둬요", raised_by: "현우" },
      ],
      concerns: [
        { title: "효과의 근거가 아직 부족함", detail: "비슷한 사례의 자료를 확인해요", raised_by: "민서" },
        { title: "이해관계에 따른 반발", detail: "반대편 의견을 미리 듣고 보완책을 마련해요", raised_by: "하율" },
      ],
      agreements: ["작게 시범으로 시작하는 게 현실적이다", "설명은 보통 사람 눈높이로 쉽게"],
      open_questions: ["시범 기간과 대상을 어떻게 정할지"],
      options: [
        { name: "A안 · 작은 시범부터", pros: ["위험이 작고 배우며 넓힐 수 있어요"], cons: ["효과가 늦게 보여요"], risks: ["시범 결과를 일반화하기 어려워요"] },
        { name: "B안 · 전면 도입", pros: ["효과가 빨리 나타나요"], cons: ["준비 부담이 커요"], risks: ["반발과 되돌리기 어려움"] },
        { name: "C안 · 보류 후 재검토", pros: ["준비할 시간을 벌어요"], cons: ["기회를 놓칠 수 있어요"], risks: ["논의가 흐지부지될 수 있어요"] },
      ],
      recommendation: "A안을 권해요. 성공 기준과 되돌리는 기준을 먼저 정하면 위험이 가장 작아요.",
      decision_points: ["시범 대상과 기간", "성공으로 볼 기준"],
      closing: "(모의 모드) 오늘 나온 조건들을 정리해서 다음 회의에서 다시 보죠.",
      private_notes: "생각보다 방향은 빨리 모였다. 남은 질문은 다음 회의에서 꼭 다시 짚어야겠다.",
    };
  }
  const f = facts(document?.text);
  return {
    verdict: "보완 후 진행", tone: "mixed",
    headline: "방향은 대체로 좋지만, 근거를 보강하고 오해를 부를 표현을 다듬은 뒤 진행하자는 결론이에요.",
    key_points: [
      { where: cut(f[0], 30), title: "핵심 주장마다 근거와 출처 보강", detail: "숫자와 사실관계를 다시 확인해요", raised_by: "민서" },
      { where: cut(f[1 % f.length], 30), title: "비교 기준과 조건 밝히기", detail: "무엇과 비교했는지 한 줄로 적어요", raised_by: "현우" },
      { title: "핵심 메시지를 맨 앞으로", detail: "가장 하고 싶은 말을 첫 문장에", raised_by: "나래" },
    ],
    concerns: [
      { where: cut(f[2 % f.length], 30), title: "받아들이는 사람에 따라 불편할 표현", detail: "반대 의견을 미리 듣고 표현을 다듬어요", raised_by: "하율" },
      { title: "처음 보는 사람에게 어려운 용어", detail: "짧은 설명이나 예시를 붙여요", raised_by: "도윤" },
    ],
    agreements: ["전체 방향과 문제의식에는 모두 공감했어요", "근거를 보강하면 설득력이 커진다"],
    open_questions: ["어느 범위까지 근거를 보강할지"],
    closing: "(모의 모드) 오늘 나온 보완점을 반영해서 다시 이야기해 봐요.",
    private_notes: "근거 보강 이야기가 가장 많았다. 다음에는 자료 담당자를 직접 불러도 좋겠다.",
  };
}

export function mockFollowup(personaId, { question, review }) {
  const q = cut(String(question || ""), 40);
  const lines = {
    moderator: `좋은 질문이에요. "${q}"에 대해서는, 회의에서 민서 님은 근거를, 하율 님은 실행했을 때의 파장을 가장 걱정했어요. 판정이 '${review?.verdict || "조건부 합의"}'인 이유도 거기 있어요. 핵심 결론 첫 항목부터 보시길 권해요.`,
    critic: `"${q}" 질문이요? 저는 여전히 근거부터 확인하는 게 먼저라고 봐요. 주장마다 출처를 붙여 보면 답이 보일 거예요.`,
    strategist: `"${q}"라면, 저는 목표부터 다시 보겠어요. 가장 먼저 기억해야 할 한 문장을 정하면 나머지 순서도 자연스럽게 정해져요.`,
    reader: `솔직히 "${q}" 부분은 처음 듣는 사람 입장에서 헷갈릴 수 있어요. 쉬운 말로 한 줄만 풀어 줘도 훨씬 나아져요.`,
    method: `"${q}"는 조건을 하나 붙여서 답해야 해요. 어떤 기준으로 판단하느냐에 따라 답이 달라지니, 기준부터 정해 두는 게 안전해요.`,
    policy: `"${q}"요? 반대하는 사람이 뭐라고 할지부터 생각해 보세요. 그 말에 미리 답을 준비해 두면 반발은 크게 줄어요.`,
  };
  return { answer: `${lines[personaId] || lines.moderator} (모의 모드)`, private_notes: `후속 질문 "${q}"에 답함.` };
}

// 단일 LLM 비교 실험 (모의): 한 번에 만든 결론은 반론과 선택지가 조금 적은 편으로 흉내 내요
export function mockBaseline({ topic }) {
  const t = cut(String(topic || "이 주제").split("\n\n[")[0].trim(), 30);
  return {
    verdict: "조건부 찬성", tone: "mixed",
    headline: `"${t}"는 장점이 있지만 준비가 필요하니 단계적으로 추진하자는 의견이에요.`,
    key_points: [{ title: "단계적으로 추진하기", detail: "작게 시작해 넓혀요" }, { title: "목표를 분명히 하기", detail: "무엇을 얻을지 정해요" }],
    concerns: [{ title: "준비 부족", detail: "사전 준비를 해요" }],
    agreements: ["단계적 추진이 현실적이다"], open_questions: ["언제 시작할지"],
    options: [{ name: "단계적 추진", pros: ["안전해요"], cons: ["느려요"], risks: [] }],
    recommendation: "단계적으로 추진하는 걸 권해요.", decision_points: ["시작 시기"],
  };
}
export function mockJudge(a, b) {
  const size = (r) => (r?.key_points?.length || 0) + (r?.concerns?.length || 0) * 2 + (r?.options?.length || 0) * 2 + (r?.open_questions?.length || 0);
  const sa = size(a), sb = size(b), hi = (x, y) => (x > y ? 4 : x === y ? 3 : 3), lo = (x, y) => (x > y ? 3 : 3);
  return {
    scores: ["관점 다양성", "비판·위험 발견", "의사결정 완성도", "논점 집중", "실행 가능성"].map((c, i) => ({ criterion: c, a: i === 3 ? 4 : sa > sb ? hi(sa, sb) + (i === 1 ? 1 : 0) : lo(sa, sb), b: i === 3 ? 4 : sb > sa ? hi(sb, sa) + (i === 1 ? 1 : 0) : lo(sb, sa), why: "(모의 채점) 담긴 반론·선택지 수를 기준으로 흉내 냈어요." })),
    better: sa > sb ? "A" : sb > sa ? "B" : "비슷", summary: "(모의 채점) 실제 모델로 돌리면 내용 기준으로 채점해요.",
  };
}
