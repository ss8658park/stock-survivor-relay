# Stock Survivor 대전 릴레이

계획서 §3 5단계. **게임 로직을 전혀 모르는 순수 중계**다.
방 코드를 관리하고 패킷을 넘기는 것이 전부다 — 판정도 검증도 하지 않는다.

## 왜 이렇게 작은가

방 코드 8글자 안에 `(시드 · 차트 인덱스 · 난이도)` 가 **전부** 들어 있다.
그래서 `round_start` 는 `room_code` 하나만 나르면 되고, 서버는 방 구성을 알 필요가 없다.

핵심 자료구조는 `Map<방코드, Map<player_id, 소켓>>` **하나**다.

## 안 하는 것 (전부 의도적)

| | 왜 |
|---|---|
| 순번(seq) 을 안 찍는다 | 클라이언트가 `(bar, owner, owner_seq)` 로 정렬한다 (§14.3) |
| 봉 시계를 안 갖는다 | 서버가 쥐면 릴레이가 죽을 때 판이 얼어붙는다 (§14.4). 클라이언트가 러버밴딩한다 |
| 끊김에 대기 창을 안 둔다 | 소켓이 닫힌 것은 이미 확정적인 정보다 (§1.8) |
| 재접속을 안 만든다 | 5분짜리 판에서 따라잡고 나면 판이 끝나 있다 (§3 5단계 규칙 5) |
| 메시지 내용을 안 본다 | 새 이벤트를 추가해도 `server.js` 를 안 고친다 |

## 하는 것

| 이벤트 | 서버가 하는 일 |
|---|---|
| `room_create` | 코드가 **이미 있으면 거부**(`code_taken`) — 방 코드 충돌 방지 (§3 5-B 2번) |
| `room_join` | 없는 방 / 정원 초과 / 같은 `player_id` 중복이면 거부 (§3 5-B 7번) |
| 그 외 전부 | 같은 방의 **나머지 사람**에게 원문 그대로. 보낸 사람에게는 안 돌려준다 |
| `leave` | 즉시 `peer_left {reason:"leave"}` |
| 소켓 닫힘 | 즉시 `peer_left {reason:"disconnect"}` |

`room_ok` 응답의 `you` / `peers` 가 클라이언트의 `local_player_id` / `foe_player_id` 가 된다.
**두 클라이언트에서 서로 뒤바뀐 값**이 되어야 명령 정렬이 양쪽에서 같아진다 (§15.4).

## ⚠️ 복제본은 반드시 1개

방 정보가 이 프로세스 **메모리에만** 있다. 2개 이상이면 같은 코드를 넣은 두 사람이
서로 다른 복제본에 붙어 **영영 못 만난다.** 늘리려면 Redis 같은 공유 저장소가 먼저다.

## 로컬에서 돌리기

```bash
npm install
npm start                 # http://localhost:8080, ws://localhost:8080
node test_relay.js        # 통합 검사 17건
node bench.js 100         # 방 100개(200명) 부하·메모리 측정
```

`curl http://localhost:8080/health` → `{"ok":true,"rooms":N,"players":M}`

## Railway 배포

> ⚠️ **이 폴더만 담는 저장소를 따로 판다.** 게임 프로젝트는 677MB 인데 릴레이는 34KB 라,
> 150줄짜리 서버를 배포하려고 그 전부를 올릴 이유가 없다. 그리고 게임 쪽은 애초에
> git 저장소가 아니다 (계획서 §1.1 — 「폴더 복사가 곧 브랜치」).

1. 이 폴더에서 `git init` → 커밋 → GitHub 의 **빈 저장소**에 push
2. Railway → **New Project → Deploy from GitHub repo** → 그 저장소 선택
3. **Settings → Serverless(유휴 시 잠재우기) 를 끈다** ← 켜 두면 WebSocket 이 끊긴다
4. **Settings → Replicas = 1** (위 경고 참조)
5. **Settings → Region** = Singapore (한국에서 가장 가깝다)
6. **Settings → Networking → Generate Domain** → `xxx.up.railway.app`
7. 클라이언트는 **`wss://`** 로 붙는다 (`ws://` 아님 — Railway 는 TLS 종단을 한다)

저장소 루트가 곧 이 폴더이므로 **Root Directory 설정이 필요 없다.**

`PORT` 는 Railway 가 환경변수로 준다. `server.js` 가 이미 읽는다. 따로 설정할 것 없다.

배포 후 같은 검사를 공개 URL 로 한 번 더:

```bash
RELAY_URL=wss://xxx.up.railway.app node test_relay.js
```

## 이벤트 로그

`stdout` 에 JSONL 한 줄씩 쌓는다 (§3 5단계 규칙 6). Railway 로그로 그대로 보인다.

⚠️ **Hobby 플랜은 로그 보관이 7일이다.** 그보다 오래 봐야 하면 따로 빼야 한다.
