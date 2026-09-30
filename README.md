# AI 검토 회의실 (A2A 시연)

분석 결과를 끌어다 놓으면, 서로 다른 회사의 AI 여섯이 A2A로 연결되어 12턴 동안 회의를 하고 검토결과를 정리합니다.
각 에이전트는 자기 명함(Agent Card), 자기 모델, 자기 개인 메모를 따로 가집니다.

| 에이전트 | 역할 | 기본 모델 |
|---|---|---|
| 사회자 | 발언 순서를 정하고 결론을 정리 | Gemini (`google/gemini-3-flash-preview`) |
| 한결 | 깐깐한 검증가: 수치, %와 %p, 표기 | Claude (`anthropic/claude-sonnet-5`) |
| 나래 | 큰 그림 전략가: 핵심 메시지, 제목, 흐름 | GPT (`openai/gpt-5.5`) |
| 보람 | 독자 대변인: 어려운 용어, 오해 소지, 한국어 문장 | Solar (`upstage/solar-pro4`) |
| 서진 | 방법론 전문가: 기준 시점, 정의, 비교 가능성 | Gemini (`google/gemini-3-flash-preview`) |
| 하율 | 정책·리스크 담당: 지역 서열화, 민감 지표, 기사 제목 | Grok (`x-ai/grok-4.20`) |

모델은 웹 화면의 설정에서 바꿀 수 있고, 고를 수 있는 회사는 OpenAI, Anthropic, Google, xAI, Upstage로 제한되어 있습니다.

## 회의 진행 (12턴)

| 턴 | 단계 | 내용 |
|---|---|---|
| 1~5 | 1라운드 | 다섯 명이 한 번씩 첫 의견. 누가 누구에게 질문하면 사회자가 그 사람을 다음으로 부릅니다 |
| 6~10 | 2라운드 | 다섯 명이 한 번씩 반론과 보완. 앞사람 발언을 짚으며 시작합니다 |
| 11 | 최종 반론 | 배포 동의 정도가 가장 낮은 두 명 중 한 명이 마지막으로 반대 의견을 냅니다 |
| 12 | 결론 | 사회자가 검토결과(판정, 꼭 고칠 것, 검토할 것, 잘된 점, 남은 질문)를 정리합니다 |

11번째 턴은 회의가 다수 의견으로 쏠린 채 끝나지 않도록, 결론 직전에 가장 반대하는 사람의 말을 한 번 더 듣는 장치입니다.

회의가 끝나면 '속마음' 탭에서 각 에이전트에게 개인 메모 공개를 요청할 수 있습니다. 회의 중에는 회의실도 그 메모를 열어 볼 수 없습니다.

## Vercel에 올리기

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Vercel에서 New Project로 저장소를 가져옵니다. Framework Preset은 `Other`, 빌드 설정은 그대로 둡니다.
3. (선택) Settings, Environment Variables에서 아래 값을 넣습니다. 하나도 안 넣어도 동작합니다.
4. Deploy.

| 환경변수 | 설명 |
|---|---|
| `OPENROUTER_API_KEY` | 서버 공용 키. 없으면 사용자가 웹에서 자기 키를 넣고, 그것도 없으면 모의 모드 |
| `MEETING_PASSCODE` | 서버 공용 키를 쓸 때 요구할 암호. 공개 URL에 서버 키를 넣었다면 꼭 설정 |
| `STATE_SECRET` | 개인 메모 암호화용 비밀값. 아무 긴 문자열 |
| `ALLOWED_VENDORS` | 고를 수 있는 모델 회사. 기본 `openai,anthropic,google,x-ai,upstage` |
| `MODEL_MODERATOR` 등 | 에이전트별 기본 모델 (`.env.example` 참고) |

## 발표 뒤 담당자들이 쓰는 방법

1. 회의실 주소로 들어가 오른쪽 위 '설정'을 누릅니다.
2. 본인 OpenRouter API 키를 넣습니다. '이 탭에서만'을 고르면 탭을 닫을 때 지워집니다.
3. 필요하면 에이전트별 모델을 바꾸고 '모두 연결 테스트'로 확인합니다.
4. 자료를 끌어다 놓고 '회의 시작'.

본인 키를 넣으면 입장 암호 없이 쓸 수 있습니다. 키는 브라우저에만 보관되고, 요청할 때 이 사이트 서버를 거쳐 OpenRouter로만 전달됩니다. 서버에 저장하지 않습니다.

## 꼭 지켜 주세요

- **공표된 자료만 올리세요.** 올린 내용은 OpenRouter를 거쳐 각 모델 회사로 전송됩니다. 엠바고 전 보도자료, 미공표 통계, 개인정보가 담긴 자료는 올리면 안 됩니다.
- OpenRouter 계정의 Privacy 설정에서 학습 이용을 끄고, 데이터 보관을 하지 않는 제공자만 쓰도록 설정하는 것을 권장합니다.
- 공개 URL에 서버 키를 넣었다면 `MEETING_PASSCODE`를 반드시 설정하세요.

## 읽을 수 있는 자료

PDF(글자가 있는 PDF), HWPX, Word(.docx), Excel(.xlsx, .xls), CSV, TSV, TXT, MD, JSON, 텍스트 붙여넣기.
HWP는 한글에서 HWPX나 PDF로 저장해서 올려 주세요. 스캔 이미지 PDF는 읽지 못합니다.
PDF는 쪽 번호를 붙여 읽기 때문에 에이전트가 "3쪽 표"처럼 위치를 짚을 수 있습니다. 6만 자가 넘으면 앞부분만 씁니다.
읽기 라이브러리는 `vendor/`에 들어 있어 외부 CDN 없이 동작합니다.

## 로컬에서 돌려 보기

Node.js 18 이상이 필요합니다.

```bash
cp .env.example .env     # 필요한 값만 채우기 (비워 두면 모의 모드)
node dev-server.mjs      # http://localhost:3000
```

API 키가 없으면 모의 모드로, 실제 모델 없이 회의 흐름 전체를 리허설할 수 있습니다.

## A2A 구조

```
GET  /api/registry                                   회의실 주소록 (에이전트 주소 목록)
GET  /agents/{id}/.well-known/agent-card.json        명함 (A2A 1.0 Agent Card)
POST /agents/{id}                                    JSON-RPC SendMessage (A2A 1.0)
GET  /api/models                                     설정 화면용 모델 목록
```

- 회의실(브라우저)이 사회자에게 다음 발언자를 묻고, 사회자가 고른 참석자에게 발언을 요청합니다.
- 공개 회의록은 모두에게 전달되지만, 개인 메모는 에이전트별 키로 암호화된 토큰으로만 오갑니다.
  서버리스라 저장소가 없어 토큰을 회의실이 들고 다니는 방식이며, 실제 서비스라면 에이전트마다 자기 DB에 두는 부분입니다.
- 발언은 작업(Task)으로, 속마음 공개는 작업 없이 메시지(Message)로 답합니다.
- API 키와 모델 선택은 A2A 메시지 본문이 아니라 HTTP 헤더(`x-openrouter-key`, `x-agent-model`)로 보내서, 회의록 JSON에 키가 남지 않습니다.
- 공식 `a2a-sdk`(Python) 클라이언트로 명함을 읽고 메시지를 보내는 것까지 확인했습니다.

## 고치고 싶을 때

- 페르소나 성격, 말투, 관심사: `api/_lib/personas.js`
- 회의 턴 구성: `index.html`의 `PLAN`
- 발언 길이, 문서 자르는 길이: `api/a2a.js`의 `clip(...)` 숫자

## 파일 구성

```
index.html            회의실 화면 (설정, 자료 읽기, 12턴 진행)
api/a2a.js            에이전트 여섯의 A2A 엔드포인트
api/registry.js       주소록
api/models.js         모델 목록 (허용 회사만)
api/_lib/personas.js  페르소나와 명함
api/_lib/llm.js       OpenRouter 호출
api/_lib/state.js     개인 메모 암호화
api/_lib/mock.js      모의 모드 응답
vendor/               PDF, HWPX, Word, Excel 읽기 라이브러리
dev-server.mjs        로컬 실행용 서버
vercel.json           주소 연결, 함수 제한시간
```
