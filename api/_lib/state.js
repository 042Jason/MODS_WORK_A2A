// Ensembly (AI 회의실) · Copyright (c) 2026 박재현. All rights reserved. 무단 복제·수정·배포 금지 (LICENSE 참고)
// 에이전트 개인 상태(메모)를 암호화해서 토큰으로 주고받습니다.
// 서버리스라 서버에 저장소가 없으니, 회의실(브라우저)이 토큰을 들고 다니되 내용은 열어 볼 수 없게 합니다.
// 실제 서비스라면 에이전트마다 자기 DB에 저장하는 부분입니다.
import crypto from "node:crypto";

function keyFor(agentId) {
  const secret = process.env.STATE_SECRET || process.env.OPENROUTER_API_KEY || "demo-only-secret";
  return crypto.createHash("sha256").update(`${secret}:${agentId}`).digest();
}

export function sealState(agentId, state) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(agentId), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openState(agentId, token) {
  const empty = { notes: "", said: [], stances: [], turns: 0 };
  if (!token) return empty;
  try {
    const raw = Buffer.from(token, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(agentId), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return { ...empty, ...JSON.parse(text) };
  } catch {
    return empty; // 다른 에이전트의 토큰이거나 변조된 토큰이면 열리지 않습니다.
  }
}
