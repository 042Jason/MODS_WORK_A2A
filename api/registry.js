// 회의실의 주소록: 어떤 에이전트에게 연락할 수 있는지, 서버 설정이 어떤지 알려 줍니다.
export default function handler(req, res) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const base = `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const pass = process.env.MEETING_PASSCODE;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    agents: ["moderator", "critic", "strategist", "reader", "method", "policy"].map((id) => `${base}/agents/${id}`),
    serverKey: Boolean(process.env.OPENROUTER_API_KEY) && process.env.MOCK_LLM !== "1",
    requiresPasscode: Boolean(pass),
    passcodeOk: !pass || req.headers["x-meeting-passcode"] === pass,
  });
}
