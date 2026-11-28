// Ensembly (AI 회의실) · Copyright (c) 2026 박재현. All rights reserved. 무단 복제·수정·배포 금지 (LICENSE 참고)
// 폰으로 함께 참여: 진행 화면(브라우저)이 회의를 돌리고, 각자 폰은 방 코드로 들어와 말만 보냅니다.
// 서버는 방마다 '우편함'만 맡아요. 폰이 보낸 말을 쌓아 두면 진행 화면이 2초마다 가져가고, 진행 화면이 올린 상황을 폰이 읽어요.
// 저장소: Upstash Redis(REST). Vercel에서 연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 이 자동으로 들어와요.
//         로컬(dev-server)에서는 저장소 없이 메모리에 둡니다. Vercel에서는 요청마다 서버가 달라서 메모리로는 안 돼요.
import crypto from "node:crypto";

const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
export const roomsReady = () => Boolean(URL_() && TOKEN()) || !process.env.VERCEL;

const TTL = 4 * 3600;               // 방은 마지막 사용 뒤 4시간이면 사라져요
const MAX_INBOX = 60, MAX_TEXT = 300, SEATS = ["me", "me2", "me3", "me4"];
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // 헷갈리는 글자(0·O, 1·I·L)는 뺐어요
const newCode = () => Array.from(crypto.randomBytes(6), (b) => ALPHA[b % ALPHA.length]).join("");
const newToken = () => crypto.randomBytes(18).toString("base64url");
const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, n);
const K = (code, part) => `ensembly:room:${code}:${part}`;

// ── 저장소 (Redis 명령 몇 개만) ──
const mem = new Map();   // 로컬용
async function redis(args) {
  const r = await fetch(URL_(), { method: "POST", headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`저장소 오류: ${j.error || r.status}`);
  return j.result;
}
const useRedis = () => Boolean(URL_() && TOKEN());
const memGet = (k) => { const v = mem.get(k); if (!v) return null; if (v.until < Date.now()) { mem.delete(k); return null; } return v.val; };
const memSet = (k, val) => mem.set(k, { val, until: Date.now() + TTL * 1000 });
async function getJSON(key) { const v = useRedis() ? await redis(["GET", key]) : memGet(key); try { return v ? JSON.parse(v) : null; } catch { return null; } }
// 폰의 요청은 방 정보와 상황을 한 번에 읽어요 (명령 한 번)
async function getRoom(code) {
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const [m, st] = useRedis() ? await redis(["MGET", K(code, "meta"), K(code, "state")]) : [memGet(K(code, "meta")), memGet(K(code, "state"))];
  return [parse(m), parse(st)];
}
async function setJSON(key, val) { const s = JSON.stringify(val); if (useRedis()) await redis(["SET", key, s, "EX", String(TTL)]); else memSet(key, s); }
async function push(key, val) {   // 우편함에 넣기 (넘치면 오래된 것부터 버려요)
  const s = JSON.stringify(val);
  if (useRedis()) await redis(["EVAL", "redis.call('RPUSH',KEYS[1],ARGV[1]); redis.call('LTRIM',KEYS[1],-tonumber(ARGV[2]),-1); redis.call('EXPIRE',KEYS[1],ARGV[3]); return 1", "1", key, s, String(MAX_INBOX), String(TTL)]);
  else memSet(key, JSON.stringify([...(JSON.parse(memGet(key) || "[]")), s].slice(-MAX_INBOX)));
}
// 진행 화면의 한 번 요청: 진행 화면인지 확인하고, 상황을 올리고, 우편함을 비우며 가져와요 (명령 한 번으로 끝나게 스크립트로)
async function hostSync(code, hostToken, state) {
  const s = JSON.stringify(state);
  if (useRedis()) {
    const [meta, items] = await redis(["EVAL", "local m=redis.call('GET',KEYS[1]); if not m then return {'gone',{}} end; if cjson.decode(m).host ~= ARGV[3] then return {'deny',{}} end; redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[2]); redis.call('EXPIRE',KEYS[1],ARGV[2]); local v=redis.call('LRANGE',KEYS[3],0,-1); redis.call('DEL',KEYS[3]); return {m,v}",
      "3", K(code, "meta"), K(code, "state"), K(code, "inbox"), s, String(TTL), String(hostToken || "")]);
    if (meta === "gone" || meta === "deny") return { err: meta };
    return { meta: JSON.parse(meta), items: (items || []).map((x) => JSON.parse(x)) };
  }
  const raw = memGet(K(code, "meta")); if (!raw) return { err: "gone" };
  const meta = JSON.parse(raw); if (!same(meta.host, hostToken)) return { err: "deny" };
  memSet(K(code, "state"), s); memSet(K(code, "meta"), raw);
  const items = JSON.parse(memGet(K(code, "inbox")) || "[]").map((x) => JSON.parse(x)); mem.delete(K(code, "inbox"));
  return { meta, items };
}

const seatOf = (meta, token) => SEATS.find((id) => same(meta.seats?.[id]?.token, token)) || null;
const taken = (meta) => Object.fromEntries(SEATS.map((id) => [id, Boolean(meta.seats?.[id])]));
// 진행 화면이 올린 상황에서 폰에 보여 줄 것만 추려요 (길이 제한)
function cleanState(st = {}) {
  return {
    at: Date.now(), topic: clip(st.topic, 160), status: ["idle", "ready", "running", "paused", "done"].includes(st.status) ? st.status : "idle", turn: clip(st.turn, 60),
    seats: (Array.isArray(st.seats) ? st.seats : []).filter((s) => SEATS.includes(s?.id)).slice(0, 4).map((s) => ({ id: s.id, name: clip(s.name, 12) })),
    ask: st.ask && SEATS.includes(st.ask.who) ? { who: st.ask.who, from: clip(st.ask.from, 12), q: clip(st.ask.q, 300) } : null,
    hand: SEATS.includes(st.hand) ? st.hand : null,
    last: (Array.isArray(st.last) ? st.last : []).slice(-6).map((t) => ({ speaker: clip(t?.speaker, 24), text: clip(t?.text, 400) })),
    headline: clip(st.headline, 200),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 받아요." });
  if (!roomsReady()) return res.status(503).json({ error: "폰으로 참여하려면 운영자가 저장소(Upstash Redis)를 연결해야 해요." });
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const code = clip(b.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");
  try {
    if (b.op === "create") {   // 진행 화면: 방 만들기
      const c = newCode(), hostToken = newToken();
      await setJSON(K(c, "meta"), { host: hostToken, seats: {}, made: Date.now() });
      await setJSON(K(c, "state"), cleanState(b.state));
      return res.status(200).json({ code: c, hostToken });
    }
    if (!code) return res.status(400).json({ error: "방 코드를 적어 주세요." });

    if (b.op === "sync") {     // 진행 화면: 상황 올리고 폰에서 온 말 가져오기
      if (b.kick && SEATS.includes(b.kick)) {   // 자리 비우기 (드물게)
        const m = await getJSON(K(code, "meta"));
        if (m && same(m.host, b.hostToken) && m.seats?.[b.kick]) { delete m.seats[b.kick]; await setJSON(K(code, "meta"), m); }
      }
      const r = await hostSync(code, b.hostToken, cleanState(b.state));
      if (r.err === "gone") return res.status(404).json({ error: "방이 닫혔어요. 다시 열어 주세요.", gone: true });
      if (r.err) return res.status(403).json({ error: "진행 화면만 할 수 있어요." });
      return res.status(200).json({ items: r.items, taken: taken(r.meta) });
    }
    if (b.op === "close") {
      const meta = await getJSON(K(code, "meta"));
      if (meta && same(meta.host, b.hostToken)) { if (useRedis()) await redis(["DEL", K(code, "meta"), K(code, "state"), K(code, "inbox")]); else ["meta", "state", "inbox"].forEach((p) => mem.delete(K(code, p))); }
      return res.status(200).json({ ok: true });
    }

    const [meta, state0] = await getRoom(code);
    if (!meta) return res.status(404).json({ error: "방을 찾지 못했어요. 코드를 다시 확인해 주세요.", gone: true });
    const state = state0 || cleanState();

    if (b.op === "state") {    // 폰: 지금 상황 보기
      return res.status(200).json({ state, taken: taken(meta), you: seatOf(meta, b.token) });
    }
    if (b.op === "join") {     // 폰: 자리 고르기
      const seat = SEATS.includes(b.seat) ? b.seat : null;
      if (!seat || !state.seats.some((s) => s.id === seat)) return res.status(400).json({ error: "그 자리는 지금 없어요. 새로고침해 주세요." });
      if (meta.seats?.[seat] && !same(meta.seats[seat].token, b.token)) return res.status(409).json({ error: "다른 분이 이미 앉은 자리예요." });
      const token = meta.seats?.[seat]?.token || newToken();
      (meta.seats ||= {})[seat] = { token, at: Date.now() };
      await setJSON(K(code, "meta"), meta);
      const name = clip(b.name, 12);
      if (name) await push(K(code, "inbox"), { seat, kind: "name", text: name, at: Date.now() });
      return res.status(200).json({ token, seat });
    }
    if (b.op === "leave") {    // 폰: 자리에서 일어나기
      const seat = seatOf(meta, b.token);
      if (seat) { delete meta.seats[seat]; await setJSON(K(code, "meta"), meta); }
      return res.status(200).json({ ok: true });
    }
    if (b.op === "send") {     // 폰: 말하기·답하기·넘기기·발언 신청
      const seat = seatOf(meta, b.token);
      if (!seat) return res.status(403).json({ error: "자리를 먼저 골라 주세요.", rejoin: true });
      const kind = ["say", "answer", "skip", "hand"].includes(b.kind) ? b.kind : null, text = clip(b.text, MAX_TEXT);
      if (!kind || ((kind === "say" || kind === "answer") && !text)) return res.status(400).json({ error: "보낼 내용을 적어 주세요." });
      await push(K(code, "inbox"), { seat, kind, text, on: b.on !== false, at: Date.now() });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "알 수 없는 요청이에요." });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
