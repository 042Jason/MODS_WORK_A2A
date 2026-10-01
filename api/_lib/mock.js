// API 키 없이 흐름을 연습할 수 있는 모의 응답. 문서에서 숫자가 들어간 문장을 뽑아 그럴듯하게 말합니다.
import { MEMBER_IDS, PERSONAS } from "./personas.js";

function facts(text) {
  const parts = (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.다음함])\s+|[□○▪■※]/)
    .map((s) => s.trim())
    .filter((s) => /\d/.test(s) && s.length > 15 && s.length < 160);
  return parts.length ? parts : ["문서 첫 부분의 수치"];
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

const LINES = {
  critic: [
    (a) => `"${a}" 여기부터 걸려요. 본문 수치랑 표 수치가 맞는지, %와 %p가 섞이지 않았는지 다시 봐야 합니다.`,
    (a, b) => `나래 님 말씀은 알겠는데, 숫자부터 맞추고요. "${b}" 부분 증감률 재계산하면 반올림 차이가 날 수 있어요.`,
  ],
  strategist: [
    (a) => `한결 님이 숫자는 잘 보실 테니, 저는 메시지를 볼게요. 이 자료의 핵심은 "${a}" 쪽인데 제목이 그걸 못 살리고 있어요.`,
    (a, b) => `정리하면 수치 보정은 한결 님 의견대로 하고, 제목은 독자가 체감하는 변화 중심으로 바꾸는 게 좋겠어요.`,
  ],
  reader: [
    (a) => `솔직히 저는 "${a}" 이 문장 두 번 읽었어요. 용어 설명이 없어서 기사로 옮기면 오해가 생길 것 같아요.`,
    (a, b) => `나래 님 방향에 동의해요. 다만 "${b}" 부분은 그래프로 보여 주면 훨씬 빨리 읽힐 거예요.`,
  ],
  method: [
    (a) => `"${a}" 이 비교는 조건이 하나 붙어야 해요. 지표마다 기준 시점과 자료원이 달라서, 주석으로 밝혀 두는 게 맞습니다.`,
    (a, b) => `한결 님 지적에 이유를 보태면, "${b}"는 표본조사 결과라 확정적인 표현은 피하는 게 좋겠어요.`,
  ],
  policy: [
    (a) => `이거 내일 기사 제목 뭐로 나올 것 같아요? "${a}" 문장은 지역 순위처럼 읽혀서 반발이 나올 수 있어요.`,
    (a, b) => `보람 님 말대로 쉬운 표현은 좋은데, 민감 지표는 순위 대신 변화 추이로 보여 주는 게 안전합니다.`,
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
  const ask = phase === "round1" && personaId === "critic" ? { to: "나래", question: "이 수치를 제목에 꼭 올려야 하나요?" }
            : phase === "round1" && personaId === "reader" ? { to: "서진", question: "이 용어, 각주 정의면 충분할까요?" }
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
    verdict: "수정 후 배포", tone: "mixed",
    headline: "핵심 발견은 분명하지만, 수치 표기와 용어 설명, 민감 지표 표현을 손봐야 합니다.",
    key_points: [
      { where: cut(f[0], 30), title: "본문과 표의 증감 표기(%, %p) 확인 필요", detail: "재계산 후 표기 통일", raised_by: "한결" },
      { where: cut(f[1 % f.length], 30), title: "지표별 기준 시점이 달라 비교 조건이 필요", detail: "표 아래 주석으로 기준 시점 명시", raised_by: "서진" },
      { where: cut(f[2 % f.length], 30), title: "지역 순위처럼 읽히는 문장", detail: "순위 대신 변화 추이 중심으로 서술", raised_by: "하율" },
    ],
    concerns: [
      { title: "제목이 가장 큰 변화를 담지 못함", detail: "변화 폭이 가장 큰 지표를 제목으로", raised_by: "나래" },
      { title: "전문용어 설명 부족", detail: "첫 등장 시 괄호로 한 줄 정의", raised_by: "보람" },
    ],
    agreements: ["지역 간 비교가 한눈에 들어오는 구성", "출처 표기가 꼼꼼함"],
    open_questions: ["후속 분석으로 연령대별 분해가 필요한지"],
    closing: "(모의 모드) 수정사항 반영해서 다시 공유해 주세요.",
  };
}

export function mockFollowup(personaId, { question, review }) {
  const q = cut(String(question || ""), 40);
  const lines = {
    moderator: `좋은 질문이에요. "${q}"에 대해서는, 회의에서 한결 님은 근거를, 하율 님은 실행했을 때의 파장을 가장 걱정했어요. 판정이 '${review?.verdict || "조건부 합의"}'인 이유도 거기 있어요. 핵심 결론 첫 항목부터 보시길 권해요.`,
    critic: `"${q}" 질문이요? 저는 여전히 숫자부터 맞추는 게 먼저라고 봐요. 본문과 표의 증감 표기를 다시 계산해 보면 답이 보일 거예요.`,
    strategist: `"${q}"라면, 저는 제목부터 다시 보겠어요. 독자가 가장 먼저 기억할 한 문장을 정하면 나머지 수정 순서도 자연스럽게 정해져요.`,
    reader: `솔직히 "${q}" 부분은 처음 읽는 사람 입장에서 헷갈릴 수 있어요. 용어에 한 줄 설명만 붙여도 훨씬 나아져요.`,
    method: `"${q}"는 조건을 하나 붙여서 답해야 해요. 지표마다 기준 시점이 달라서, 주석으로 그 차이를 밝혀 두는 게 안전해요.`,
    policy: `"${q}"요? 이게 내일 기사 제목으로 어떻게 나올지부터 생각해 보세요. 순위처럼 읽히는 문장만 피해도 반발은 크게 줄어요.`,
  };
  return { answer: `${lines[personaId] || lines.moderator} (모의 모드)`, private_notes: `후속 질문 "${q}"에 답함.` };
}
