// 릴레이 통합 시험 — websocat 대신 이걸로 자동 검증한다.
const WebSocket = require("ws");
const URL = process.env.RELAY_URL || "ws://localhost:8080";
let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  (" + detail + ")" : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  (" + detail + ")" : "")); }
};
const open = () => new Promise((res) => { const w = new WebSocket(URL); w.q = []; w.on("message", (m) => { const o = JSON.parse(m); (w.waiter ? w.waiter(o) : w.q.push(o)); }); w.on("open", () => res(w)); });
const next = (w) => new Promise((res) => { if (w.q.length) return res(w.q.shift()); w.waiter = (o) => { w.waiter = null; res(o); }; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const CODE = "7K3MPQ2V";
  const a = await open(), b = await open();

  a.send(JSON.stringify({ kind: "room_create", room_code: CODE, player_id: "P1", protocol: "sv1" }));
  let m = await next(a);
  ok("방을 만든다", m.kind === "room_ok" && m.you === "P1", JSON.stringify(m));
  ok("처음엔 상대가 없다", Array.isArray(m.peers) && m.peers.length === 0);

  // 같은 코드로 또 만들면 거부해야 한다 (§3 5-B 2번 방 코드 충돌)
  const c = await open();
  c.send(JSON.stringify({ kind: "room_create", room_code: CODE, player_id: "PX", protocol: "sv1" }));
  m = await next(c);
  ok("같은 코드로 또 만들면 거부한다", m.kind === "error" && m.code === "code_taken", m.code);

  b.send(JSON.stringify({ kind: "room_join", room_code: CODE, player_id: "P2", protocol: "sv1" }));
  m = await next(b);
  ok("코드로 들어간다", m.kind === "room_ok" && m.you === "P2", JSON.stringify(m));
  ok("상대 이름을 알려준다", m.peers.length === 1 && m.peers[0] === "P1", JSON.stringify(m.peers));
  m = await next(a);
  ok("먼저 있던 사람에게 알린다", m.kind === "peer_joined" && m.player_id === "P2");

  // 정원 초과
  c.send(JSON.stringify({ kind: "room_join", room_code: CODE, player_id: "P3", protocol: "sv1" }));
  m = await next(c);
  ok("정원이 차면 거부한다", m.kind === "error" && m.code === "room_full", m.code);
  // 같은 사람 두 번
  const d = await open();
  d.send(JSON.stringify({ kind: "room_join", room_code: CODE, player_id: "P1", protocol: "sv1" }));
  m = await next(d);
  ok("같은 player_id 는 거부한다", m.kind === "error" && m.code === "duplicate_player", m.code);
  // 없는 방
  d.close();
  const e = await open();
  e.send(JSON.stringify({ kind: "room_join", room_code: "ZZZZZZZZ", player_id: "PQ", protocol: "sv1" }));
  m = await next(e);
  ok("없는 방은 거부한다", m.kind === "error" && m.code === "no_such_room", m.code);
  // 잘못된 코드 형식
  e.send(JSON.stringify({ kind: "room_create", room_code: "abc", player_id: "PQ", protocol: "sv1" }));
  m = await next(e);
  ok("형식이 틀린 코드는 거부한다", m.kind === "error" && m.code === "bad_code", m.code);
  e.close();

  // ── 버전 불일치 (§18) ──
  // 결정론적 락스텝이라 클라이언트가 한 줄만 달라도 판이 갈린다. 그 증상은
  // **디싱크로만** 나타나므로 붙기 전에 막아야 한다.
  const v = await open();
  v.send(JSON.stringify({ kind: "room_join", room_code: CODE, player_id: "PV", protocol: "sv-OLD" }));
  m = await next(v);
  ok("판이 다르면 거부한다", m.kind === "error" && m.code === "version_mismatch", m.code);
  v.send(JSON.stringify({ kind: "room_join", room_code: CODE, player_id: "PV" }));
  m = await next(v);
  ok("판을 안 보내면 거부한다", m.kind === "error" && m.code === "no_protocol", m.code);
  v.close();

  // ── 중계 ──
  const cast = { kind: "cast", bar: 47, owner: "P1", skill_id: "spark", row: 5, col: 2 };
  a.send(JSON.stringify(cast));
  m = await next(b);
  ok("보낸 것이 상대에게 그대로 간다", JSON.stringify(m) === JSON.stringify(cast), JSON.stringify(m));
  ok("보낸 사람에게는 안 돌아온다", a.q.length === 0, "큐 " + a.q.length);

  // 서버가 모르는 이벤트도 그대로 넘어가야 한다 (서버는 내용을 안 본다)
  const weird = { kind: "totally_new_event", whatever: [1, 2, 3] };
  b.send(JSON.stringify(weird));
  m = await next(a);
  ok("모르는 이벤트도 그대로 넘긴다", JSON.stringify(m) === JSON.stringify(weird));

  // ── 끊김: 대기 창 없이 즉시 ──
  const t0 = Date.now();
  b.close();
  m = await next(a);
  const dt = Date.now() - t0;
  ok("상대가 끊기면 즉시 알린다", m.kind === "peer_left" && m.player_id === "P2", JSON.stringify(m));
  ok("대기 창이 없다 (1초 이내)", dt < 1000, dt + "ms");
  ok("끊김과 나가기를 구분한다", m.reason === "disconnect", m.reason);

  // 방이 비면 코드가 풀려야 재사용 가능
  a.close();
  await sleep(200);
  const f = await open();
  f.send(JSON.stringify({ kind: "room_create", room_code: CODE, player_id: "P9", protocol: "sv1" }));
  m = await next(f);
  ok("방이 비면 코드를 다시 쓸 수 있다", m.kind === "room_ok", m.kind + "/" + (m.code || ""));
  f.close(); c.close();

  await sleep(200);
  console.log("\n검사 " + (pass + fail) + "건 / 실패 " + fail + "건");
  process.exit(fail ? 1 : 0);
})();
