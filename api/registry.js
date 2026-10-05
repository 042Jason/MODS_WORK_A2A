// Ensembly (AI 회의실) · Copyright (c) 2026 박재현. All rights reserved. 무단 복제·수정·배포 금지 (LICENSE 참고)
// 회의실의 주소록: 어떤 에이전트에게 연락할 수 있는지, 지금 어떤 키로 돌아가는지 알려 줍니다.
import { SHARED_MAX_TURNS, passcodeOk } from "./_lib/auth.js";

export default function handler(req, res) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const base = `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    agents: ["moderator", "critic", "strategist", "reader", "method", "policy"].map((id) => `${base}/agents/${id}`),
    serverKey: Boolean(process.env.OPENROUTER_API_KEY) && process.env.MOCK_LLM !== "1",
    requiresPasscode: Boolean(process.env.MEETING_PASSCODE),
    passcodeOk: passcodeOk(req),
    sharedMaxTurns: SHARED_MAX_TURNS,
  });
}
