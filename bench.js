const WebSocket = require("ws");
const URL = "ws://localhost:8080";
const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const code = (n) => { let s="", v=n; for (let i=0;i<8;i++){ s = A[v & 31] + s; v = Math.floor(v/32); } return s; };
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
const mem = () => { try { return Number(require("child_process").execSync(
  'powershell -NoProfile -Command "(Get-Process node | Sort-Object WS -Descending | Select-Object -First 1).WS"',
  {encoding:"utf8"}).trim())/1048576; } catch { return -1; } };

(async () => {
  const rooms = Number(process.argv[2] || 100);
  const socks = [];
  for (let i = 0; i < rooms; i++) {
    const c = code(i + 1);
    for (const [pid, kind] of [["P1","room_create"],["P2","room_join"]]) {
      const w = new WebSocket(URL);
      await new Promise(r => w.on("open", r));
      w.recv = 0;
      w.on("message", () => { w.recv++; });
      w.send(JSON.stringify({ kind, room_code: c, player_id: pid }));
      socks.push(w);
    }
  }
  await sleep(1200);
  const h = await (await fetch("http://localhost:8080/health")).json();

  // 실제 게임 부하: 한 사람이 한 판(100봉)에 보내는 양 ≈ 140건
  const N = 140;
  const before = socks.reduce((s,w)=>s+w.recv, 0);
  const t0 = Date.now();
  for (let k = 0; k < N; k++)
    for (const w of socks) w.send(JSON.stringify({kind:"sync",bar:k,checksum:1234567890}));
  // 전부 중계될 때까지 기다린다
  const want = before + socks.length * N;   // 1대1이라 발신 1건 = 상대 1건 수신
  let waited = 0;
  while (socks.reduce((s,w)=>s+w.recv,0) < want && waited < 30000) { await sleep(50); waited += 50; }
  const ms = Date.now() - t0;
  const m = mem();
  console.log(`방 ${h.rooms} / 인원 ${h.players} / 접속 ${socks.length}`);
  console.log(`  한 판 분량 ${socks.length*N}건 중계에 ${ms}ms  (${Math.round(socks.length*N/(ms/1000))} msg/s)`);
  console.log(`  서버 메모리 ${m.toFixed(1)} MB`);
  for (const w of socks) w.close();
  await sleep(400);
  process.exit(0);
})();
