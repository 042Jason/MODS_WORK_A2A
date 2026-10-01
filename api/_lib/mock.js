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

export function mockModerate({ transcript, phase, eligible, hasDoc = true }) {
  const last = [...transcript].reverse().find((t) => t.role !== "moderator");
  let next = eligible[0];
  const asked = last?.ask?.to && Object.values(PERSONAS).find((p) => p.name === last.ask.to)?.id;
  if (asked && eligible.includes(asked)) next = asked;
  const say = phase === "last_word"
    ? `결론 내기 전에, ${NAME(next)} 님이 아직 가장 걸리는 부분을 한 번 더 말씀해 주세요.`
    : transcript.length === 0
      ? `${hasDoc ? "자료" : "주제"} 잘 받았습니다. ${NAME(next)} 님부터 첫 의견 부탁드려요.`
      : asked === next
        ? `${NAME(next)} 님, 방금 질문에 답해 주시겠어요?`
        : phase !== "round1"
          ? `${NAME(next)} 님, 앞선 의견 중 동의하기 어려운 게 있으면 짚어 주세요.`
          : `${NAME(next)} 님은 어떻게 보셨어요?`;
  return { next, say, reason: asked === next ? `${NAME(next)} 님이 질문을 받았으니 바로 답하게 함` : `아직 이번 라운드에 말하지 않은 ${NAME(next)} 님 차례` };
}

const LINES = {   // 첨부 자료가 있을 때의 대사 (자료 속 문장 a, b를 인용)
  critic: [
    (a) => `"${a}" 여기부터 걸려요. 이 주장의 근거가 자료 어디에 있는지, 숫자라면 계산이 맞는지 다시 봐야 합니다.`,
    (a, b) => `나래 님 말씀은 알겠는데, 사실관계부터 맞추고요. "${b}" 부분은 출처와 기준을 한 번 더 확인해야 해요.`,
  ],
  strategist: [
    (a) => `한결 님이 근거는 잘 보실 테니, 저는 핵심을 볼게요. 이 자료가 말하려는 건 "${a}" 쪽인데 그게 잘 안 드러나요.`,
    (a, b) => `정리하면 사실 확인은 한결 님 의견대로 하고, 핵심 메시지는 맨 앞으로 끌어올리는 게 좋겠어요.`,
  ],
  reader: [
    (a) => `솔직히 저는 "${a}" 이 문장 두 번 읽었어요. 처음 보는 사람은 오해할 수 있을 것 같아요.`,
    (a, b) => `나래 님 방향에 동의해요. 다만 "${b}" 부분은 예시를 하나 붙이면 훨씬 쉽게 읽힐 거예요.`,
  ],
  method: [
    (a) => `"${a}" 이 부분은 조건이 하나 붙어야 해요. 무엇을 기준으로 비교했는지 밝혀 두는 게 맞습니다.`,
    (a, b) => `한결 님 지적에 이유를 보태면, "${b}"는 일부 사례에서 나온 이야기라 단정적인 표현은 피하는 게 좋겠어요.`,
  ],
  policy: [
    (a) => `이거 반대하는 사람은 뭐라고 할까요? "${a}" 문장은 받아들이는 사람에 따라 불편하게 읽힐 수 있어요.`,
    (a, b) => `보람 님 말대로 쉽게 쓰는 건 좋은데, 민감한 부분은 미리 반대 의견을 들어 보고 표현을 다듬는 게 안전합니다.`,
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
    () => `한결 님 지적에 보태면, 다른 사례에서 효과가 있었다고 여기서도 같을 거라고 단정하면 안 돼요.`,
  ],
  policy: [
    (t) => `이거 실제로 하면 누가 제일 반대할 것 같아요? "${t}"는 이해관계가 꽤 갈릴 거예요.`,
    () => `보람 님 말대로 설명은 쉬워야 하고, 반대편 말을 미리 듣고 보완책을 준비해 두는 게 안전해요.`,
  ],
};

export function mockMember(personaId, { document, myTurn, phase, topic }) {
  if (!document?.text) {
    const i = phase === "round1" ? 0 : 1;
    return {
      utterance: TOPIC_LINES[personaId][i](cut(String(topic || "이 주제").trim(), 30)),
      stance: phase === "round1" ? "보류" : personaId === "policy" ? "우려" : "동의",
      confidence: phase === "round1" ? 50 : personaId === "policy" ? 45 : 70,
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
            : phase === "round1" && personaId === "reader" ? { to: "서진", question: "이 용어, 짧은 설명만 붙이면 충분할까요?" }
            : { to: null, question: "" };
  return {
    utterance: LINES[personaId][i](a, b),
    stance: phase === "round1" ? "우려" : personaId === "policy" ? "우려" : "동의",
    confidence: phase === "round1" ? 40 + k * 3 : 60 + k * 2,
    ask,
    private_notes: phase === "round1"
      ? `첫인상으로는 고칠 게 꽤 보인다. 다음엔 "${b}" 부분을 더 봐야겠다.`
      : `다른 분들 의견으로 많이 정리됐다. 그래도 "${a}" 부분은 끝까지 짚고 넘어가고 싶다.`,
  };
}

export function mockSummary({ document, topic }) {
  if (!document?.text) {
    const t = cut(String(topic || "이 주제").trim(), 30);
    return {
      verdict: "조건부 합의", tone: "mixed",
      headline: `"${t}"에 대체로 찬성하지만, 목표와 성공 기준을 먼저 정하고 작게 시범으로 시작하자는 결론이에요.`,
      key_points: [
        { title: "목표를 한 문장으로 먼저 정하기", detail: "무엇을 얻으려는지 정하면 우선순위가 정리돼요", raised_by: "나래" },
        { title: "성공 기준을 숫자로 정의하기", detail: "시작 전에 비교 기준을 정해 둬요", raised_by: "서진" },
      ],
      concerns: [
        { title: "효과의 근거가 아직 부족함", detail: "비슷한 사례의 자료를 확인해요", raised_by: "한결" },
        { title: "이해관계에 따른 반발", detail: "반대편 의견을 미리 듣고 보완책을 마련해요", raised_by: "하율" },
      ],
      agreements: ["작게 시범으로 시작하는 게 현실적이다", "설명은 보통 사람 눈높이로 쉽게"],
      open_questions: ["시범 기간과 대상을 어떻게 정할지"],
      closing: "(모의 모드) 오늘 나온 조건들을 정리해서 다음 회의에서 다시 보죠.",
    };
  }
  const f = facts(document?.text);
  return {
    verdict: "보완 후 진행", tone: "mixed",
    headline: "방향은 대체로 좋지만, 근거를 보강하고 오해를 부를 표현을 다듬은 뒤 진행하자는 결론이에요.",
    key_points: [
      { where: cut(f[0], 30), title: "핵심 주장마다 근거와 출처 보강", detail: "숫자와 사실관계를 다시 확인해요", raised_by: "한결" },
      { where: cut(f[1 % f.length], 30), title: "비교 기준과 조건 밝히기", detail: "무엇과 비교했는지 한 줄로 적어요", raised_by: "서진" },
      { title: "핵심 메시지를 맨 앞으로", detail: "가장 하고 싶은 말을 첫 문장에", raised_by: "나래" },
    ],
    concerns: [
      { where: cut(f[2 % f.length], 30), title: "받아들이는 사람에 따라 불편할 표현", detail: "반대 의견을 미리 듣고 표현을 다듬어요", raised_by: "하율" },
      { title: "처음 보는 사람에게 어려운 용어", detail: "짧은 설명이나 예시를 붙여요", raised_by: "보람" },
    ],
    agreements: ["전체 방향과 문제의식에는 모두 공감했어요", "근거를 보강하면 설득력이 커진다"],
    open_questions: ["어느 범위까지 근거를 보강할지"],
    closing: "(모의 모드) 오늘 나온 보완점을 반영해서 다시 이야기해 봐요.",
  };
}

export function mockFollowup(personaId, { question, review }) {
  const q = cut(String(question || ""), 40);
  const lines = {
    moderator: `좋은 질문이에요. "${q}"에 대해서는, 회의에서 한결 님은 근거를, 하율 님은 실행했을 때의 파장을 가장 걱정했어요. 판정이 '${review?.verdict || "조건부 합의"}'인 이유도 거기 있어요. 핵심 결론 첫 항목부터 보시길 권해요.`,
    critic: `"${q}" 질문이요? 저는 여전히 근거부터 확인하는 게 먼저라고 봐요. 주장마다 출처를 붙여 보면 답이 보일 거예요.`,
    strategist: `"${q}"라면, 저는 목표부터 다시 보겠어요. 가장 먼저 기억해야 할 한 문장을 정하면 나머지 순서도 자연스럽게 정해져요.`,
    reader: `솔직히 "${q}" 부분은 처음 듣는 사람 입장에서 헷갈릴 수 있어요. 쉬운 말로 한 줄만 풀어 줘도 훨씬 나아져요.`,
    method: `"${q}"는 조건을 하나 붙여서 답해야 해요. 어떤 기준으로 판단하느냐에 따라 답이 달라지니, 기준부터 정해 두는 게 안전해요.`,
    policy: `"${q}"요? 반대하는 사람이 뭐라고 할지부터 생각해 보세요. 그 말에 미리 답을 준비해 두면 반발은 크게 줄어요.`,
  };
  return { answer: `${lines[personaId] || lines.moderator} (모의 모드)`, private_notes: `후속 질문 "${q}"에 답함.` };
}
