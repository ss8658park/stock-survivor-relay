// 실제 왕복 지연 측정 — 두 클라이언트가 릴레이를 거쳐 주고받는 시간.
// ★ 게임에서 중요한 것은 "내가 보낸 것이 상대에게 닿는 시간"이므로 **편도**다.
const WebSocket = require("ws");
const URL = process.env.RELAY_URL || "ws://localhost:8080";
const N = Number(process.env.N || 30);
const open = () => new Promise((res) => { const w = new WebSocket(URL); w.on("open", () => res(w)); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const a = await open(), b = await open();
  const CODE = "PNG12345";
  a.send(JSON.stringify({kind:"room_create", room_code:CODE, player_id:"P1"}));
  await sleep(300);
  b.send(JSON.stringify({kind:"room_join", room_code:CODE, player_id:"P2"}));
  await sleep(400);

  const samples = [];
  let resolve = null;
  b.on("message", (m) => { const o = JSON.parse(m); if (o.kind === "cast" && resolve) resolve(); });
  a.on("message", (m) => { const o = JSON.parse(m); if (o.kind === "error") { console.log("서버 거부:", o.code, o.detail); process.exit(1); } });
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    const done = new Promise(r => { resolve = r; setTimeout(() => r("timeout"), 5000); });
    a.send(JSON.stringify({kind:"cast", bar:i, owner:"P1", skill_id:"spark", row:1, col:1}));
    await done;
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep(60);
  }
  samples.sort((x,y)=>x-y);
  const p = (q) => samples[Math.floor(samples.length * q)].toFixed(0);
  const avg = (samples.reduce((s,v)=>s+v,0)/samples.length).toFixed(0);
  console.log(`표본 ${N}개 — A가 보낸 것이 B에 닿기까지 (편도, 릴레이 경유)`);
  console.log(`  최소 ${samples[0].toFixed(0)}ms / 중앙값 ${p(0.5)}ms / 평균 ${avg}ms / p90 ${p(0.9)}ms / 최대 ${samples[samples.length-1].toFixed(0)}ms`);
  a.close(); b.close();
  await sleep(300); process.exit(0);
})();
