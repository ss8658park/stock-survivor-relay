// Stock Survivor 대전 릴레이
// ─────────────────────────────────────────────────────────────
// ★ 이 서버는 **게임 로직을 전혀 모른다** (계획서 §3 5단계).
//   방 코드를 관리하고 패킷을 넘기는 것이 전부다. 판정도 검증도 하지 않는다.
//   방 코드 8글자 안에 (시드·차트 인덱스·난이도)가 전부 들어 있으므로
//   서버는 방 구성을 알 필요가 없다.
//
// ⚠️ 하지 않는 것 — 전부 의도적이다.
//   · 순번(seq) 을 찍지 않는다. 클라이언트가 (bar, owner, owner_seq) 로 정렬한다 (§14.3)
//   · 봉 시계를 갖지 않는다. 서버가 쥐면 릴레이가 죽을 때 판이 얼어붙는다 (§14.4)
//   · 끊김에 대기 창을 두지 않는다. 소켓이 닫힌 것은 이미 확정적인 정보다 (§1.8)
//   · 재접속을 만들지 않는다 (§3 5단계 규칙 5)
//
// ⚠️ **복제본은 반드시 1개.** 방 정보가 이 프로세스 메모리에만 있으므로, 2개 이상이면
//    같은 코드를 넣은 두 사람이 서로 다른 복제본에 붙어 영영 못 만난다.

"use strict";

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

// 게임은 1대1 이지만 방 구조는 N명이다 (4인 대전은 나중에 — 계획서 §6).
const MAX_PER_ROOM = Number(process.env.MAX_PER_ROOM || 2);

// VersusConfig.ROOM_ALPHABET 과 **같아야 한다**: "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
// (I·L·O·U 가 빠진 Crockford 계열 — 손으로 옮겨 적을 때 헷갈리는 글자를 뺐다)
const CODE_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

// 죽은 소켓을 걷어내는 주기. 이것과 게임의 `sync` 는 **다른 것**이다 —
// 이쪽은 TCP 가 조용히 끊긴 것을 찾는 용도고, `sync` 는 게임 상태 지문이다.
const PING_MS = 30_000;

/** code -> Map<player_id, ws> */
const rooms = new Map();

// ── 이벤트 로그 (§3 5단계 규칙 6) ─────────────────────────────
// 1일차부터 남긴다. 저장은 싸고, 나중에 재접속을 넣을 때 그것이 유일한 재료이며
// 디싱크 추적·리플레이에도 그대로 쓴다.
// ⚠️ Railway Hobby 는 **로그 보관이 7일**이다. 그보다 오래 봐야 하면 따로 빼야 한다.
function log(event, data) {
  process.stdout.write(JSON.stringify({ t: Date.now(), event, ...data }) + "\n");
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function fail(ws, code, detail) {
  send(ws, { kind: "error", code, detail: detail || "" });
  log("error", { code, detail, pid: ws.playerId, room: ws.roomCode });
}

/** 방의 나머지 사람들에게 그대로 넘긴다. 보낸 사람에게는 돌려주지 않는다. */
function relay(ws, raw) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  for (const [pid, peer] of room) {
    if (pid !== ws.playerId) peer.send(raw);
  }
}

function leaveRoom(ws, reason) {
  const room = rooms.get(ws.roomCode);
  if (!room || room.get(ws.playerId) !== ws) return;
  room.delete(ws.playerId);
  log("leave", { room: ws.roomCode, pid: ws.playerId, reason, left: room.size });

  // ★ 남은 사람에게 **즉시** 알린다. 대기 창을 두지 않는다 (§1.8).
  //   `reason` 을 실어 보내는 이유: 클라이언트가 「나가기」와 「조용히 끊김」을
  //   구분해야 결과 화면의 `ended_by` 가 정확해진다.
  for (const peer of room.values()) {
    send(peer, { kind: "peer_left", player_id: ws.playerId, reason });
  }
  if (room.size === 0) {
    rooms.delete(ws.roomCode);
    log("room_closed", { room: ws.roomCode });
  }
}

// ── HTTP: 상태 확인용 한 줄 ──────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    let players = 0;
    for (const r of rooms.values()) players += r.size;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.playerId = null;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (buf) => {
    const raw = buf.toString();

    // 아직 방에 안 들어왔으면 create/join 만 받는다.
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return fail(ws, "bad_json");
    }
    const kind = String(msg.kind || "");

    if (kind === "room_create" || kind === "room_join") {
      const code = String(msg.room_code || "").toUpperCase();
      const pid = String(msg.player_id || "");
      if (!CODE_RE.test(code)) return fail(ws, "bad_code", code);
      if (!pid) return fail(ws, "bad_player_id");
      if (ws.roomCode) return fail(ws, "already_in_room", ws.roomCode);

      const exists = rooms.has(code);

      // ⚠️ **방 코드 중복을 여기서 막는다** (계획서 §3 5-B 2번).
      //    코드는 (시드·차트·난이도) 를 그대로 담는데 시드가 `Time.get_ticks_usec()` 라
      //    가동 시간이 비슷하면 값도 가깝다 — 켜자마자 방을 만드는 것이 보통이라
      //    분포가 한쪽에 몰린다. 겹치면 **남의 판에 들어간다.**
      if (kind === "room_create" && exists) {
        return fail(ws, "code_taken", code);   // 클라이언트가 다시 뽑는다
      }
      if (kind === "room_join" && !exists) {
        return fail(ws, "no_such_room", code);
      }

      const room = exists ? rooms.get(code) : new Map();
      if (!exists) rooms.set(code, room);

      // 같은 사람이 두 번 들어오는 것과 정원 초과를 막는다 (§3 5-B 7번).
      if (room.has(pid)) return fail(ws, "duplicate_player", pid);
      if (room.size >= MAX_PER_ROOM) return fail(ws, "room_full", code);

      ws.roomCode = code;
      ws.playerId = pid;
      room.set(pid, ws);

      const peers = [...room.keys()].filter((p) => p !== pid);
      // ★ `you` / `peers` 가 클라이언트의 `local_player_id` / `foe_player_id` 가 된다.
      //   **두 클라이언트에서 서로 뒤바뀐 값**이 되어야 명령 정렬이 양쪽에서 같아진다
      //   (§15.4). 그래서 서버가 사람 이름을 알려주는 것이 중요하다.
      send(ws, { kind: "room_ok", room_code: code, you: pid, peers });
      for (const [p, peer] of room) {
        if (p !== pid) send(peer, { kind: "peer_joined", player_id: pid });
      }
      log(kind, { room: code, pid, size: room.size });
      return;
    }

    if (!ws.roomCode) return fail(ws, "not_in_room", kind);

    // ── 여기부터가 중계다. **서버는 내용을 안 본다.** ─────────
    // `round_start` / `enter` / `close` / `cast` / `sync` / `round_end` / `rematch`
    // 전부 그대로 넘어간다. 새 이벤트를 추가해도 이 파일은 안 고친다.
    if (kind === "leave") {
      log("event", { room: ws.roomCode, pid: ws.playerId, kind });
      leaveRoom(ws, "leave");
      ws.close();
      return;
    }
    log("event", { room: ws.roomCode, pid: ws.playerId, kind, msg });
    relay(ws, raw);
  });

  ws.on("close", () => leaveRoom(ws, "disconnect"));
  ws.on("error", () => leaveRoom(ws, "disconnect"));
});

// TCP 가 조용히 끊긴 소켓을 걷어낸다.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_MS);

server.listen(PORT, () => log("listening", { port: PORT, maxPerRoom: MAX_PER_ROOM }));
