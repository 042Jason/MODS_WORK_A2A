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

export function mockModerate({ transcript, phase, eligible }) {
  const last = [...transcript].reverse().find((t) => t.role !== "moderator");
  let next = eligible[0];
  const asked = last?.ask?.to && Object.values(PERSONAS).find((p) => p.name === last.ask.to)?.id;
  if (asked && eligible.includes(asked)) next = asked;
  const say = phase === "last_word"
    ? `결론 내기 전에, ${NAME(next)} 님이 아직 가장 걸리는 부분을 한 번 더 말씀해 주세요.`
    : transcript.length === 0
      ? `자료 잘 받았습니다. ${NAME(next)} 님부터 첫 의견 부탁드려요.`
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

export function mockMember(personaId, { document, myTurn, phase }) {
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

export function mockSummary({ document }) {
  const f = facts(document?.text);
  return {
    verdict: "수정 후 배포",
    headline: "핵심 발견은 분명하지만, 수치 표기와 용어 설명, 민감 지표 표현을 손봐야 합니다.",
    must_fix: [
      { where: cut(f[0], 30), issue: "본문과 표의 증감 표기(%, %p) 확인 필요", suggestion: "재계산 후 표기 통일", raised_by: "한결" },
      { where: cut(f[1 % f.length], 30), issue: "지표별 기준 시점이 달라 비교 조건이 필요", suggestion: "표 아래 주석으로 기준 시점 명시", raised_by: "서진" },
      { where: cut(f[2 % f.length], 30), issue: "지역 순위처럼 읽히는 문장", suggestion: "순위 대신 변화 추이 중심으로 서술", raised_by: "하율" },
    ],
    consider: [
      { issue: "제목이 가장 큰 변화를 담지 못함", suggestion: "변화 폭이 가장 큰 지표를 제목으로", raised_by: "나래" },
      { issue: "전문용어 설명 부족", suggestion: "첫 등장 시 괄호로 한 줄 정의", raised_by: "보람" },
    ],
    strengths: ["지역 간 비교가 한눈에 들어오는 구성", "출처 표기가 꼼꼼함"],
    open_questions: ["후속 분석으로 연령대별 분해가 필요한지"],
    closing: "(모의 모드) 수정사항 반영해서 다시 공유해 주세요.",
  };
}
