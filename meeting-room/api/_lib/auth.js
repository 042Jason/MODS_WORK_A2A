// 인증키 확인. 인증키(MEETING_PASSCODE)가 맞는 사람만 운영자의 공용 키를 쓸 수 있습니다.
// 인증키를 설정하지 않았다면 누구나 공용 키를 씁니다. 공개 주소라면 꼭 설정하세요.
import crypto from "node:crypto";

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
