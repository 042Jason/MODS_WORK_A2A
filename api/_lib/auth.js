// Ensembly (AI 회의실) · Copyright (c) 2026 박재현. All rights reserved. 무단 복제·수정·배포 금지 (LICENSE 참고)
// 인증키 확인. 인증키(MEETING_PASSCODE)가 맞는 사람만 운영자의 공용 키를 쓸 수 있습니다.
// 인증키를 설정하지 않았다면 누구나 공용 키를 씁니다. 공개 주소라면 꼭 설정하세요.
import crypto from "node:crypto";

// 공용 키(운영자 키)로 할 수 있는 최대 턴 수. 내 API 키를 쓰면 이 제한이 없어요.
export const SHARED_MAX_TURNS = Math.max(2, parseInt(process.env.SHARED_MAX_TURNS || "12", 10) || 12);

export function passcodeOk(req) {
  const pass = process.env.MEETING_PASSCODE;
  if (!pass) return true;
  let given = String(req.headers["x-meeting-passcode"] || "");
  try { given = decodeURIComponent(given); } catch {}
  // 길이와 상관없이 같은 시간에 비교하도록 해시끼리 비교
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(pass).digest();
  return crypto.timingSafeEqual(a, b);
}
