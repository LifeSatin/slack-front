# Meet:U Slack 봇 프론트엔드 구현 명세서

> 기준일: 2026-08-20  
> 기준 코드: `luckivicki4-App/backend`, `luckivicki4-App/frontend`, `luckivicki4-AI`  
> 문서 상태: 구현 코드 역산 명세 + Slack 연동 설계안

## 1. 목적과 범위

이 문서는 현재 Spring Boot 백엔드와 AI 협상 서버의 실제 계약에 맞춰 Slack 봇 형태의 프론트엔드를 구현하기 위한 기준이다. REST, STOMP, SSE 계약은 현재 코드에 존재하는 동작을 기술하고, Slack 전용 계약은 아직 서버에 없는 기능을 별도로 표시한다.

Slack 봇의 책임은 다음과 같다.

- Slack 요청의 진위를 검증하고 3초 안에 응답한다.
- Slack 사용자 및 채널을 Meet:U의 사용자 및 채팅방과 연결한다.
- Slack 채널 메시지를 백엔드 채팅 메시지로 전달한다.
- 일정 조율 시작, 진행 상태, 에이전트 발화, 성공·실패 결과를 Slack 메시지로 표현한다.
- Google Calendar 연결이 필요한 사용자를 웹 OAuth 흐름으로 안내한다.
- Slack 재전송과 백엔드 재연결 상황에서도 메시지를 중복 생성하지 않는다.

Slack 봇은 Google Calendar를 직접 호출하지 않는다. 캘린더 조회, 일정 생성, Google OAuth 토큰 보관은 Spring 백엔드가 담당하고, 실제 일정 협상은 별도 FastAPI AI 서버가 담당한다.

## 2. 시스템 경계

```text
Slack 사용자
   │ Events API / Slash Command / Block Action
   ▼
Slack Bot Adapter (새 프론트엔드, 서버 런타임 필요)
   │ REST + STOMP
   ▼
Spring Boot Backend :8080
   │ POST /negotiate                  ▲ progress/message/result callback
   ▼                                  │
FastAPI AI Service :8000 ─────────────┘
   │ freebusy 조회 / Google 일정 생성
   ▼
Spring Boot Backend → Google Calendar API
```

브라우저 없이 동작하는 Slack 앱은 비밀키 보관과 Slack 서명 검증이 필요하므로 순수 React SPA로 구현할 수 없다. Node.js/Bolt 같은 서버형 어댑터를 권장한다. Socket Mode를 쓰면 공개 인바운드 URL 없이 개발할 수 있지만, 운영 환경에서는 Events API 방식도 가능하다.

공개 Slack Marketplace 배포가 목표라면 Socket Mode 앱은 현재 Marketplace 등록 대상이 아니므로 HTTP Events API 방식을 선택한다. 사내 단일 워크스페이스 또는 개발 환경이라면 Socket Mode를 사용할 수 있다.

## 3. 현재 서버 계약과 Slack 적용 가능성

| 영역 | 현재 구현 | Slack 봇 적용 |
|---|---|---|
| 사용자 생성 | Google OAuth 후 `GET /api/auth/me`, 개발용 `POST /dev/users` | 운영용 Slack 사용자 연결 API가 새로 필요 |
| 사용자 식별 | REST `X-USER-ID`, STOMP CONNECT `userId` | 서버 간 인증 없이 그대로 노출하면 안 됨 |
| 채팅방 | 생성/내 목록 REST | Slack 채널과 방의 영속 매핑 필요 |
| 메시지 송신 | STOMP SEND만 제공 | 봇이 STOMP 클라이언트가 되거나 REST 송신 API 추가 필요 |
| 메시지 수신 | 사용자별 STOMP 큐 | 봇 서비스가 대표 내부 사용자로 연결해 수신 가능하나 운영용 서비스 구독 방식 권장 |
| 협상 시작 | 메시지에 `/bot` 포함 또는 REST 시작 | Slack 명령을 REST 시작으로 변환 권장 |
| 알림 | Google OAuth 세션 기반 REST/SSE | 봇 서버에서 직접 사용하기 부적합; Slack DM용 서버 이벤트 계약 필요 |
| 캘린더 | Spring이 Google OAuth 토큰으로 처리 | Slack 사용자를 Google 계정에 연결해야 함 |

## 4. 식별자와 매핑 모델

현재 내부 식별자는 숫자형 `user.id`, `room.id`다. Slack 식별자는 문자열이며 워크스페이스마다 범위가 다르다. 다음 매핑을 서버 DB에 추가해야 한다.

### 4.1 Slack 사용자 연결

```ts
type SlackUserLink = {
  teamId: string;             // Slack workspace ID, 예: T0123
  slackUserId: string;        // 예: U0456
  internalUserId: number;     // Meet:U users.id
  slackEmail?: string;
  linkedAt: string;           // offset 포함 ISO 8601
};
```

고유 제약은 `(teamId, slackUserId)`와 `internalUserId`에 둔다. 이메일만으로 계정을 자동 연결하지 않는다. 사용자가 Slack에서 `/meetu connect`를 실행하고, 일회용 state가 포함된 링크에서 Google OAuth를 완료한 뒤 연결하는 방식이 안전하다.

### 4.2 Slack 채널 연결

```ts
type SlackChannelLink = {
  teamId: string;
  channelId: string;
  internalRoomId: number;
  createdBySlackUserId: string;
  botThreadTs?: string;
  createdAt: string;
};
```

고유 제약은 `(teamId, channelId)`다. Slack 채널 멤버 변경 시 내부 채팅방 멤버가 자동 변경되지 않는 것이 현재 서버 모델의 한계다. MVP에서는 `/meetu init` 시점의 멤버를 고정하고, 이후 변경은 `/meetu sync`로 명시적으로 동기화한다.

## 5. 권장 Slack UX

### 5.1 명령

기본 슬래시 명령은 `/meetu` 하나로 구성한다.

| 입력 | 동작 | 응답 공개 범위 |
|---|---|---|
| `/meetu help` | 사용법 표시 | ephemeral |
| `/meetu connect` | Google Calendar 연결 링크 표시 | ephemeral |
| `/meetu status` | 내 계정 연결 및 현재 채널 방 연결 상태 | ephemeral |
| `/meetu init [방 이름]` | 현재 채널 멤버로 내부 채팅방 생성 | 채널 공지 + 실패는 ephemeral |
| `/meetu sync` | 채널 멤버와 내부 멤버 차이 검사/동기화 | ephemeral |
| `/meetu schedule <요청>` | 요청을 메시지로 저장한 뒤 협상 시작 | 채널 스레드 |
| `/meetu retry` | 새 협상 시작 | 채널 스레드 |

`/bot` 문자열은 현재 Spring 백엔드가 메시지 내부에서 감지하는 레거시 트리거다. Slack 사용자는 `/meetu schedule`을 사용하고, 어댑터는 요청 문장을 일반 메시지로 저장한 후 `POST /chat/rooms/{roomId}/negotiations`를 호출한다. 메시지에 `/bot`까지 넣으면 협상이 두 번 시작될 수 있으므로 두 방식을 동시에 사용하지 않는다.

### 5.2 일정 요청 예

```text
/meetu schedule 다음 주 화요일이나 수요일 오후에 1시간 회고 회의 잡아줘
```

봇은 즉시 다음 메시지를 채널에 작성하고 `ts`를 협상 표시용 스레드 기준으로 저장한다.

```text
📅 일정 조율을 시작했어요.
요청: 다음 주 화요일이나 수요일 오후에 1시간 회고 회의 잡아줘
참가자: @민지, @준호, @수빈
상태: 요청을 분석하는 중
```

이후 진행 상태는 새 메시지를 계속 쌓기보다 같은 부모 메시지를 `chat.update`로 갱신하고, 에이전트 발화만 스레드 답글로 추가한다.

### 5.3 진행 상태 표시

| 서버 phase | Slack 문구 |
|---|---|
| `analyzing` | 요청을 분석하는 중 |
| `checking_calendars` | 참가자 캘린더를 확인하는 중 |
| `negotiating` | 가능한 시간을 조율하는 중 |
| `revalidating` | 최종 시간을 다시 확인하는 중 |

### 5.4 에이전트 발화 표시

`AGENT_EVENT`의 `eventType`을 다음과 같이 표시한다.

| eventType | 아이콘 | 의미 |
|---|---:|---|
| `MESSAGE` | 💭 | 일반 진행/생각 |
| `PROPOSE` | 🗓️ | 시간 제안 |
| `ACCEPT` | ✅ | 제안 수락 |
| `REJECT` | ↩️ | 제안 거절 |

현재 Spring의 `AgentEventResponse`에는 `proposedSlot`과 실제 참가자 정보가 포함되지 않고 `message`만 보존된다. Slack에서 구조화된 시간 블록이나 참가자 아바타를 정확히 표시하려면 해당 필드를 서버 이벤트에 추가해야 한다.

### 5.5 결과 표시

성공(`status=converged`) 시:

```text
✅ 일정이 확정되고 Google Calendar에 등록됐어요.
2026년 8월 25일(화) 14:00–15:00 (Asia/Seoul)
```

실패(`status=failed`) 시:

```text
❌ 일정 조율에 실패했어요. 조건을 바꿔 다시 시도해 주세요.
[다시 요청하기]
```

서버 시간은 offset 포함 ISO 8601로 전달되지만 `createdAt`은 `LocalDateTime`이라 offset이 없다. 일정 슬롯은 `Asia/Seoul`로 변환해 표시하고, 생성 시각은 서버 로컬 시간이 KST라는 배포 가정이 확정되기 전까지 상대 시간 계산에 사용하지 않는다.

## 6. 현재 REST API 상세

기본 URL은 로컬 기준 `http://localhost:8080`이다. JSON 요청에는 `Content-Type: application/json`을 사용한다.

### 6.1 현재 사용자 조회

`GET /api/auth/me`

- 인증: Google OAuth 세션 쿠키 `MELO_SESSION` 필수
- 성공: `200`

```json
{
  "id": 1,
  "name": "민지",
  "email": "minji@example.com",
  "picture": "https://..."
}
```

- 미인증: `401`
- Slack 봇 적용: 사용자의 브라우저 OAuth 완료 페이지에서만 사용한다. 봇 서버가 사용자 세션을 대신 보유하지 않는다.

### 6.2 로그아웃

`POST /api/auth/logout` → 성공 시 HTTP status 반환, 세션과 `MELO_SESSION` 삭제.

### 6.3 채팅방 생성

`POST /chat/rooms`

- 헤더: `X-USER-ID: <양의 정수>`
- 요청자 본인은 서버가 자동 포함한다.

```json
{
  "title": "제품팀 회의",
  "memberIds": [2, 3]
}
```

검증 규칙:

- `title`: 공백 불가, 최대 40자, 저장 전 trim
- `memberIds`: null 불가, 중복은 제거
- 요청자 포함 최소 2명
- 모든 멤버가 존재하고 Google Calendar OAuth 토큰을 보유해야 함

성공 `201`:

```json
{
  "roomId": 10,
  "title": "제품팀 회의",
  "createdBy": 1,
  "createdAt": "2026-08-20T20:10:00",
  "members": [
    { "userId": 1, "displayName": "민지" },
    { "userId": 2, "displayName": "준호" }
  ]
}
```

### 6.4 내 채팅방 목록

`GET /chat/rooms`

- 헤더: `X-USER-ID`
- 성공 `200`: `ChatRoomResponse[]`
- 사용자가 없으면 `404`

### 6.5 최근 메시지

`GET /chat/rooms/{roomId}/messages?size=50`

- 헤더: `X-USER-ID`
- `size`는 서버에서 1~250으로 보정
- 멤버가 아니면 `403`
- 성공 `200`: 오래된 메시지부터 정렬된 배열
- AI 발화와 같은 내용으로 판별된 메시지는 이 조회 결과에서 제외될 수 있다.

```json
[
  {
    "messageId": 101,
    "roomId": 10,
    "senderId": 1,
    "senderName": "민지",
    "sequence": 7,
    "clientMessageId": "f2b3cb1e-0c3c-4d6c-80fb-d3e77b1c193a",
    "content": "다음 주 수요일 오후 어때요?",
    "createdAt": "2026-08-20T20:12:30",
    "duplicated": false
  }
]
```

### 6.6 협상 시작

`POST /chat/rooms/{roomId}/negotiations`

- 헤더: `X-USER-ID`
- body 없음
- 방 멤버만 가능
- 성공 `202`, body 없음
- 서버는 시작 시점까지의 최근 메시지 최대 250개를 AI 서버로 보낸다.
- 채팅이 한 건도 없으면 현재 구현상 `500`이 될 수 있다. 어댑터는 반드시 요청 메시지 저장 확인 후 호출한다.
- 응답에는 `sessionId`가 없다. 실제 sessionId는 이후 STOMP 진행 이벤트에서 획득한다.

### 6.7 최근 AI 이벤트

`GET /chat/rooms/{roomId}/agent-events/latest`

- 헤더: `X-USER-ID`
- 이벤트 있음: `200 AgentEventResponse`
- 이벤트 없음: `204`

```json
{
  "type": "AGENT_EVENT",
  "id": 3,
  "roomId": 10,
  "sessionId": "room-10-...",
  "eventType": "PROPOSE",
  "message": "수요일 오후 2시를 제안합니다.",
  "createdAt": "2026-08-20T20:13:00"
}
```

### 6.8 캘린더 API

Slack 봇이 직접 호출하지 않는 내부 계약이다.

`GET /users/{userId}/freebusy?start=<ISO>&end=<ISO>`

- `userId`: 숫자 문자열
- `start`, `end`: offset 포함 ISO 8601, `start < end`
- 성공 `200`: `[{"start":"...","end":"..."}]`

`POST /api/events`

```json
{
  "title": "제품 회고",
  "slot": {
    "start": "2026-08-25T14:00:00+09:00",
    "end": "2026-08-25T15:00:00+09:00"
  },
  "participants": ["1", "2", "3"]
}
```

- 제목: 최대 255자
- 참가자: 1명 이상, 숫자 문자열
- 성공 `201`, body 없음
- Google Calendar 오류: `502`

## 7. STOMP/WebSocket 계약

### 7.1 연결

- WebSocket URL: `ws://localhost:8080/ws/chat` 또는 TLS 환경의 `wss://.../ws/chat`
- 프로토콜: STOMP 1.2, SockJS 아님
- CONNECT native header: `userId: "<internal user id>"`
- 서버는 양의 정수 및 사용자 존재 여부만 검사한다.
- 권장 heartbeat: `10000,10000`

운영 Slack 어댑터가 임의 사용자 ID로 접속할 수 있는 현재 방식은 인증 경계가 아니다. 서비스 계정 토큰 또는 서명된 JWT CONNECT 헤더로 교체해야 한다.

### 7.2 송신

Destination: `/app/chat/rooms/{roomId}/messages`

```json
{
  "clientMessageId": "UUID v4",
  "content": "다음 주 화요일 오후에 1시간 회의"
}
```

규칙:

- `clientMessageId`: UUID 문자열 필수
- 동일 방·동일 발신자·동일 ID 재전송은 중복 저장하지 않으며 응답의 `duplicated=true`
- `content`: trim 후 비어 있으면 안 됨, 최대 2,000자
- 방 멤버만 송신 가능
- 내용에 `/bot`이 포함되고 중복 메시지가 아니면 자동으로 협상 시작

Slack 이벤트 재전송의 안정적인 멱등 키는 Slack `event_id` 또는 `(team_id, channel_id, ts)`를 UUID v5로 변환해 사용한다. 무작위 UUID를 매 재시도마다 만들면 중복 방지가 작동하지 않는다.

### 7.3 구독

| Destination | payload |
|---|---|
| `/user/queue/chat/messages` | `ChatMessageResponse` |
| `/user/queue/chat/errors` | `{message, occurredAt}` |
| `/user/queue/chat/negotiations` | `NEGOTIATION_PROGRESS` 또는 `NEGOTIATION_RESULT` |
| `/user/queue/chat/agent-events` | `AgentEventResponse` |

진행 이벤트:

```json
{
  "type": "NEGOTIATION_PROGRESS",
  "roomId": 10,
  "sessionId": "room-10-...",
  "phase": "checking_calendars"
}
```

결과 이벤트:

```json
{
  "type": "NEGOTIATION_RESULT",
  "roomId": 10,
  "sessionId": "room-10-...",
  "status": "converged",
  "slot": {
    "start": "2026-08-25T14:00:00+09:00",
    "end": "2026-08-25T15:00:00+09:00"
  }
}
```

`failed`일 때 `slot`은 null이다. 연결 해제 시 지수 백오프와 jitter로 재접속하고, 재접속 후 현재 REST API로는 놓친 결과를 조회할 수 없으므로 Slack 운영 전 세션별 상태 조회 API 추가가 필요하다.

## 8. 알림 API와 SSE

알림 API는 `MELO_SESSION` Google OAuth 세션이 필수이므로 Slack 봇 서버의 일반적인 서버 간 호출에는 적합하지 않다.

- `GET /api/notifications?page=0&size=10`
- `GET /api/notifications/unread-count`
- `PATCH /api/notifications/{notificationId}/read`
- `PATCH /api/notifications/read-all`
- `GET /api/notifications/subscribe` (`text/event-stream`)

SSE 이벤트 이름은 `connected`, `notification`, `notification-read`, `notifications-read-all`이고 서버 권장 재연결 시간은 3초, emitter timeout은 1시간이다. Slack 봇 MVP는 STOMP의 협상 이벤트를 채널에 전달하고, 일정 생성/실패 개인 알림은 후속 서버 이벤트 또는 webhook 계약이 생긴 뒤 DM으로 지원한다.

## 9. 오류 계약과 사용자 메시지

일반 REST 오류 JSON:

```json
{
  "status": 403,
  "error": "FORBIDDEN",
  "message": "채팅방 접근 권한이 없습니다.",
  "occurredAt": "2026-08-20T20:30:00"
}
```

| HTTP | 처리 |
|---:|---|
| 400 | 입력 안내를 ephemeral로 표시 |
| 401 | 연결 버튼 표시 |
| 403 | 권한 또는 캘린더 연결 부족 사용자 안내 |
| 404 | 사용자/방 매핑을 재확인하고 `/meetu init` 안내 |
| 409 | 메시지 충돌; 동일 멱등 키면 성공 여부 재조회 |
| 502 | Google Calendar 일시 오류 안내, 자동 무한 재시도 금지 |
| 500 | 추적 ID와 함께 일반 오류 표시, 상세 서버 메시지는 노출 금지 |

Slack command/event 수신은 검증 완료 후 3초 이내 ack하고 실제 백엔드 호출은 비동기로 수행한다. 실패는 `response_url` 또는 `chat.postEphemeral`로 후속 통지한다.

## 10. Slack 어댑터 상태 머신

```text
IDLE
 └─ schedule 요청 → ACCEPTED
                    ├─ analyzing
                    ├─ checking_calendars
                    ├─ negotiating
                    └─ revalidating
                         ├─ converged → SUCCEEDED
                         └─ failed    → FAILED
```

상태 키는 `sessionId`다. `POST .../negotiations` 응답에 sessionId가 없으므로 시작 직후에는 `(teamId, channelId, requestTs, roomId)`로 임시 상태를 만들고 최초 진행 이벤트의 `roomId/sessionId`를 연결한다. 같은 방에서 동시에 두 협상을 시작하면 정확한 상관관계가 보장되지 않는다. 따라서 MVP는 방별 활성 협상을 하나로 제한하고, 백엔드가 `sessionId`를 202 응답에 반환하도록 개선해야 한다.

최종 상태 이후 같은 `sessionId`의 중복 이벤트는 무시한다. Slack API 호출은 `sessionId + event type + agentEvent.id`를 외부 멱등 키로 기록한다.

## 11. Slack 앱 권한과 이벤트

권장 Bot Token Scopes:

- `commands`
- `chat:write`
- `users:read`
- `users:read.email` — 연결 UX에서 이메일을 보조 정보로 쓸 때만
- `channels:read`, `groups:read` — 공개/비공개 채널 멤버 확인 범위에 맞게
- `channels:history`, `groups:history` — 일반 채널 메시지를 요청 문맥으로 수집할 때만
- `im:write` — 개인 연결/알림을 DM으로 보낼 때

권장 이벤트는 `app_mention`, 필요 시 `message.channels` 및 `message.groups`다. 봇 메시지(`bot_id` 존재), subtype 메시지, 다른 워크스페이스 이벤트는 제외한다. URL Verification, Slack signing secret 검증, timestamp 5분 이내 검증을 반드시 구현한다. Socket Mode라면 `connections:write` app-level token이 추가로 필요하다.

최소 권한 원칙상 `/meetu schedule`만 지원하는 MVP는 채널 history 이벤트 권한 없이 구현할 수 있다. 이 경우 사용자가 명령에 전체 요청을 넣고, 어댑터가 해당 텍스트만 백엔드 메시지로 저장한다.

## 12. 봇 처리 순서

### 12.1 연결

1. 사용자가 `/meetu connect` 실행.
2. 어댑터가 10분 만료, 1회용 `state`를 만들고 ephemeral OAuth 링크 반환.
3. 브라우저에서 Spring Google OAuth 수행.
4. OAuth 성공 콜백에서 Slack `teamId/slackUserId`와 내부 `userId` 연결.
5. Slack DM 또는 ephemeral로 완료 안내.

현재 Spring OAuth 성공 핸들러는 일반 프론트 URL로 리다이렉트하므로 Slack 연결 state를 보존하고 링크 레코드를 생성하는 전용 콜백이 필요하다.

### 12.2 채널 초기화

1. `/meetu init` 요청자 연결 여부 확인.
2. Slack 채널 멤버 목록 조회.
3. 각 멤버의 내부 계정과 Calendar 연결 여부 확인.
4. 미연결 멤버가 있으면 이름과 연결 버튼을 ephemeral로 제공하고 중단.
5. 연결된 내부 ID로 `POST /chat/rooms`.
6. 성공한 `roomId`를 채널 매핑에 저장.

### 12.3 협상

1. 요청자/채널/방 매핑과 활성 협상 유무 확인.
2. 요청 텍스트를 STOMP로 저장. 송신 confirmation 메시지를 받을 때까지 다음 단계로 넘어가지 않는다.
3. 동일 `messageId` 수신 또는 `duplicated=true`로 저장을 확인.
4. `POST /chat/rooms/{roomId}/negotiations` 호출.
5. 채널에 진행 부모 메시지 생성.
6. STOMP progress를 부모 메시지 갱신으로 반영.
7. agent event를 스레드 답글로 반영.
8. result를 최종 메시지로 반영하고 활성 상태 해제.

## 13. Slack 운영을 위해 필요한 백엔드 변경

다음은 선택적 UI 개선이 아니라 운영 가능한 Slack 프론트엔드를 위해 필요한 계약이다.

### P0 — 필수

1. **서버 간 인증**: `X-USER-ID`와 STOMP `userId`를 서비스 토큰/JWT 기반 대리 호출로 교체한다. 현재는 누구나 숫자 ID를 위조할 수 있다.
2. **Slack 계정 연결 API/테이블**: `(teamId, slackUserId) ↔ internalUserId` 저장과 일회용 OAuth state 흐름을 추가한다.
3. **Slack 채널 매핑 저장소**: `(teamId, channelId) ↔ roomId`를 영속화한다.
4. **메시지 REST 송신 API 또는 서비스 STOMP 인증**: 봇 서버가 안정적으로 메시지를 저장할 공식 경로가 필요하다.
5. **협상 시작 응답**: `202 {"sessionId":"room-..."}`를 반환한다.
6. **협상 상태 조회**: `GET /chat/rooms/{roomId}/negotiations/latest` 또는 `GET /api/negotiations/{sessionId}`를 제공해 재접속 누락을 복구한다.
7. **내부 콜백 인증**: Spring의 `/api/negotiations/**`, `/users/*/freebusy`, `/api/events`에서 `X-Internal-Token`을 검증하고 Spring→AI `/negotiate`에도 동일 헤더를 전송한다. AI 서버만 토큰 옵션을 구현한 현재 상태에서는 양방향 보호가 완성되지 않는다.

### P1 — 권장

1. 에이전트 이벤트에 `participant`, `action`, `proposedSlot`을 보존·전달한다.
2. 방 멤버 추가/제거 또는 Slack 채널 동기화 API를 제공한다.
3. 협상 시작 중복 방지와 방별 active session 제약을 둔다.
4. 성공 결과에 생성된 Google Calendar event link를 포함한다. 현재 `POST /api/events`는 `201` body 없음이라 Slack에서 일정 링크를 표시할 수 없다.
5. `createdAt`을 `OffsetDateTime`으로 통일한다.
6. 알림을 Slack DM으로 전달할 수 있는 service event/webhook/outbox를 제공한다.

## 14. 구현 모듈 제안

```text
slack-bot/
├── src/
│   ├── app.ts                  # Bolt 앱과 미들웨어
│   ├── commands/meetu.ts       # help/connect/init/status/schedule/retry
│   ├── events/appMention.ts
│   ├── actions/retry.ts
│   ├── clients/backend.ts      # REST 계약, timeout, 오류 정규화
│   ├── clients/stomp.ts        # 연결/구독/재연결/heartbeat
│   ├── services/identity.ts    # Slack↔내부 사용자
│   ├── services/channelLink.ts # Slack 채널↔room
│   ├── services/negotiation.ts # 상태 머신과 Slack 갱신
│   ├── views/blocks.ts         # Block Kit 생성
│   └── types/contracts.ts      # 이 문서의 DTO
└── test/
    ├── commands/
    ├── contracts/
    └── negotiation/
```

환경 변수:

| 변수 | 용도 |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` 봇 토큰 |
| `SLACK_SIGNING_SECRET` | HTTP 요청 서명 검증 |
| `SLACK_APP_TOKEN` | Socket Mode 사용 시 `xapp-...` |
| `SLACK_SOCKET_MODE` | Socket Mode 여부 |
| `BACKEND_BASE_URL` | Spring REST base URL |
| `BACKEND_WS_URL` | Spring WebSocket URL |
| `BACKEND_SERVICE_TOKEN` | 추가할 서버 간 인증 토큰 |
| `PUBLIC_BASE_URL` | OAuth callback 링크 생성 |
| `DATABASE_URL` | 사용자/채널/협상 매핑 저장 |

비밀 값은 로그에 남기지 않는다. 로그 키는 `teamId`, `channelId`, `roomId`, `sessionId`, Slack `event_id`로 제한하고 이메일·메시지 본문은 기본적으로 마스킹한다.

## 15. 기존 프론트엔드를 기준으로 한 핵심 기능 목록

이 절은 `frontend/src/App.jsx`와 `frontend/src/MeetUApp.jsx`에서 실제 제공하는 사용자 흐름을 Slack 환경으로 옮긴 구현 체크리스트다. **MUST**는 Slack 봇 MVP에 반드시 포함하고, **SHOULD**는 기존 웹과의 기능 동등성을 위해 권장하며, **OUT**은 Slack 자체 기능으로 대체하거나 초기 범위에서 제외한다.

### 15.1 한눈에 보는 필수 기능

| 우선순위 | 핵심 기능 | 기존 웹 프론트엔드 | Slack 봇 구현 형태 | 완료 조건 |
|---|---|---|---|---|
| MUST | 사용자 인증 및 Calendar 연결 | Google 로그인, `/api/auth/me` | `/meetu connect`, 개인 OAuth 링크, 연결 완료 DM/ephemeral | Slack 사용자와 내부 user ID가 영속 연결되고 Calendar 사용 가능 여부를 확인할 수 있음 |
| MUST | 채널/채팅방 연결 | 방 생성, 참여자 선택 | `/meetu init`, Slack 채널 멤버를 내부 member ID로 변환 | 채널 하나가 내부 room 하나에 중복 없이 연결됨 |
| MUST | 참가자 검증 | 이름·이메일 검색, `calendarConnected` 표시 | 초기화/동기화 시 연결 안 된 멤버 목록과 연결 버튼 표시 | 미연결 참가자가 있으면 방 생성·협상을 막고 누구인지 안내 |
| MUST | 일정 요청 문맥 저장 | 2,000자 실시간 채팅 | `/meetu schedule <요청>` 텍스트를 내부 메시지로 저장 | 저장 confirmation 후에만 협상 시작 |
| MUST | 협상 명시적 시작 | `AI 일정 조율 시작` 버튼 | `/meetu schedule`, `일정 조율` Block Kit 버튼 | 한 사용자 동작이 협상 한 건만 시작 |
| MUST | 실시간 진행 표시 | 요청 전달/조율/재시도/완료 패널 | Slack 부모 메시지 갱신 + 스레드 답글 | 네 progress phase와 agent event가 해당 session에 연결되어 표시됨 |
| MUST | 성공·실패 결과 | 성공/실패 상태와 확정 슬롯 | 최종 Block Kit 메시지, KST 시간, 재시도 버튼 | `converged`는 slot 필수, `failed`는 slot 없이 표현 |
| MUST | 중복 방지 | UUID `clientMessageId`, message ID 중복 제거 | Slack `event_id` 기반 UUID/처리 로그 | Slack 재전송에도 내부 메시지, 협상, 답글이 각 1회 |
| MUST | 오류와 복구 | API/WS 오류, 작성 내용 유지, 다시 시도 | ephemeral 오류, 재연결, 재시도 버튼 | 오류 원인과 다음 행동을 알려주고 입력을 잃지 않음 |
| SHOULD | 방 상태 확인 | 방 목록과 현재 선택 방 | `/meetu status` | 현재 채널의 room ID, 참가자, 활성 협상 상태 확인 가능 |
| SHOULD | 최근 문맥 확인 | 최근 메시지 최대 50개 | `/meetu context` 또는 App Home | AI에 들어갈 최근 요청 문맥을 사용자가 확인 가능 |
| SHOULD | 내 향후 일정 요약 | 앞으로 7일 freebusy 패널 | `/meetu calendar` ephemeral 또는 App Home | 개인에게만 busy slot을 노출하고 공개 채널에는 표시하지 않음 |
| SHOULD | 확정 일정 강조 | 새 slot 강조 후 캘린더 새로고침 | 성공 메시지와 Google Calendar 링크 | 확정 시간이 즉시 보이고 가능하면 실제 event link로 이동 |
| SHOULD | 알림 | 알림 목록·미확인 수·SSE | App Home 또는 DM | 일정 성공/실패를 대상 사용자에게 한 번만 전달 |

### 15.2 사용자 연결과 로그인 — MUST

기존 웹은 Google OAuth 로그인 후 `/api/auth/me`에서 내부 사용자 ID와 프로필을 얻는다. Slack 봇에서도 Calendar 권한이 없으면 핵심 기능을 수행할 수 있으므로 로그인은 부가 기능이 아니다.

필수 동작:

1. `/meetu connect` 실행 시 링크는 요청한 Slack 사용자에게만 ephemeral로 노출한다.
2. 링크에는 workspace, Slack user, 만료 시각과 연결된 일회용 state를 포함한다.
3. OAuth 완료 후 Slack 사용자와 내부 사용자를 연결하고 연결 성공 여부를 Slack으로 회신한다.
4. `/meetu status`에서 `연결됨`, `Calendar 재연결 필요`, `미연결`을 구분한다.
5. 토큰 만료·회수 시 재연결 경로를 제공한다.

기존 웹의 로그아웃은 개인 브라우저 세션 제거이므로 Slack 봇에서는 `/meetu disconnect`로 대체한다. disconnect는 Slack 매핑만 끊을지 Google authorized client까지 폐기할지 서버 정책을 먼저 확정해야 한다.

### 15.3 채널 초기화와 참가자 관리 — MUST

기존 웹의 방 생성 dialog는 사용자를 이름/이메일로 검색하고, `calendarConnected=false`인 사용자는 선택할 수 없게 한다. Slack에서는 수동 user ID 입력을 노출하지 않고 채널 멤버를 기준으로 처리한다.

필수 동작:

- 요청자 자신을 참가자에 자동 포함한다.
- 봇 계정, 삭제된 사용자, 게스트의 참여 정책을 명시적으로 적용한다.
- 최소 두 명의 연결된 사용자가 있어야 한다.
- 미연결 멤버가 있으면 Slack 멘션과 함께 Calendar 연결 필요 상태를 표시한다.
- 동일 채널에서 `/meetu init`을 다시 실행해도 새 방을 중복 생성하지 않는다.
- `/meetu sync`는 추가/제거 예정 인원을 먼저 보여주고 확인 후 적용한다.

현재 백엔드는 방 생성 후 멤버 수정 API가 없으므로 `/meetu sync`의 실제 변경 기능은 해당 API가 추가될 때까지 상태 비교와 안내만 제공한다.

### 15.4 요청 입력과 대화 문맥 — MUST

기존 웹은 방 안의 대화를 저장하고 마지막 최대 250개 메시지를 AI 협상 문맥으로 사용한다. Slack 전체 채널 대화를 무단으로 백엔드에 복제하면 권한·개인정보 범위가 커지므로 MVP에서는 `/meetu schedule` 뒤의 텍스트만 저장한다.

필수 동작:

- 빈 요청과 2,000자 초과 요청을 Slack에서 먼저 거부한다.
- Slack mrkdwn, 사용자 멘션, 채널 링크를 AI가 이해할 수 있는 안정적인 일반 텍스트로 정규화한다.
- Slack 원문 `ts`와 내부 `clientMessageId/messageId`를 함께 기록한다.
- 내부 메시지 수신 confirmation을 받지 못하면 협상을 시작하지 않는다.
- 일반 Slack 메시지의 자동 수집은 별도 동의와 history scope 없이는 활성화하지 않는다.

### 15.5 협상 시작과 진행 상태 — MUST

기존 `MeetUApp.jsx`는 `starting`, `dispatching`, `attempting`, `retrying`, `thinking`, `success`, `fail` 상태를 구분하고, 서버의 진행 이벤트는 `analyzing`, `checking_calendars`, `negotiating`, `revalidating`을 제공한다. Slack 구현의 상태 원본은 서버 이벤트여야 하며 클라이언트 타이머만으로 성공을 추정하면 안 된다.

필수 동작:

- 시작 요청 직후 `요청 전달 중` 상태를 표시한다.
- 최초 progress에서 `sessionId`를 임시 요청과 연결한다.
- progress는 부모 메시지를 갱신하고 agent event는 같은 스레드에 순서대로 추가한다.
- 같은 room에서 활성 session이 있으면 새 요청을 막거나 명시적 취소/재시작 확인을 받는다.
- 최종 result를 받은 뒤 진행 중 표시와 timeout을 해제한다.
- 재연결 후 서버 상태 조회로 최종 상태를 보정한다. 상태 조회 API 추가 전에는 복구 불가 상태를 사용자에게 숨기지 않는다.

### 15.6 결과 및 Calendar 피드백 — MUST/SHOULD

기존 웹은 협상 성공 시 확정 slot을 별도로 강조하고 사용자 Calendar를 다시 조회한다.

MUST:

- 성공 시 시작·종료 시각, 시간대, 참가자, 일정 제목을 표시한다.
- 실패 시 일반 오류와 일정 조율 실패를 구분하고 조건 변경 또는 재시도 행동을 제공한다.
- `failed` 결과에 이전 성공 slot이 남지 않도록 session별 상태를 분리한다.
- 모든 사용자에게 공개해도 되는 결과만 채널에 표시한다. 개인의 busy slot은 절대 공개하지 않는다.

SHOULD:

- 백엔드가 event URL을 반환하도록 개선되면 `Google Calendar에서 열기` 버튼을 제공한다.
- 성공 후 사용자별 DM은 채널 최종 메시지와 중복되지 않도록 전달 기록을 둔다.

### 15.7 실시간 연결, 멱등성, 장애 복구 — MUST

기존 웹은 STOMP의 messages/errors/negotiations/agent-events 네 큐를 구독하고, WebSocket이 끊긴 동안에도 작성 중인 텍스트를 유지한다. Slack에서는 입력 자체는 Slack이 보존하지만 명령 처리 상태와 백엔드 이벤트 구독을 봇 서버가 영속적으로 관리해야 한다.

필수 동작:

- STOMP heartbeat, 지수 백오프+jitter 재연결, 재구독을 구현한다.
- Slack 수신 ack와 실제 작업 완료를 분리한다.
- Slack `event_id`, command payload fingerprint, Block action ID를 처리 이력에 저장한다.
- 내부 UUID는 동일 Slack 요청에 대해 항상 같은 값이 나오도록 생성한다.
- agent event는 `id`, 결과는 `sessionId + status`로 중복 제거한다.
- 프로세스 재시작 후에도 진행 중 협상과 Slack 부모 메시지 `ts`를 복구한다.
- Slack API rate limit의 `Retry-After`를 준수하며, 최종 결과를 progress보다 낮은 우선순위로 밀어내지 않는다.

### 15.8 오류 UX — MUST

기존 웹의 오류 문구처럼 사용자가 다음 행동을 알 수 있어야 한다. 내부 stack trace, 토큰, participant의 Calendar 상세는 표시하지 않는다.

| 상황 | Slack 응답 |
|---|---|
| 사용자 미연결 | `Google Calendar 연결이 필요해요.` + 연결 버튼 |
| 일부 참가자 미연결 | 미연결 사용자 멘션 + 각자의 연결 안내 |
| 채널 미초기화 | `먼저 /meetu init을 실행해 주세요.` |
| 이미 조율 중 | 현재 진행 메시지 링크 + 새 조율 차단 |
| STOMP 연결 끊김 | 요청은 보존하고 `서버 연결을 복구 중이에요.` 표시 |
| Google Calendar 502 | 잠시 후 재시도 안내, 자동 무한 재시도 금지 |
| 조율 실패 result | 조건을 바꾼 재요청 버튼/명령 안내 |
| 알 수 없는 서버 오류 | 일반 오류 + 운영 추적 ID |

### 15.9 Slack에서 대체하거나 초기 범위에서 제외할 웹 기능

| 웹 기능 | Slack 처리 |
|---|---|
| 좌측 채팅방 목록/선택 | Slack 채널 자체가 방 선택 UI이므로 제외 |
| 자체 메시지 composer와 스크롤 고정 | Slack 기본 composer/스레드로 대체 |
| 캐릭터 애니메이션과 3초 성공/실패 mood | 이모지와 Block Kit 상태로 단순화 |
| 브라우저 `sessionStorage`의 선택 방 기억 | 채널 매핑 DB로 대체 |
| 전체 알림 bell·읽음 처리 UI | MVP 제외, 후속 App Home/DM으로 대체 |
| 공개 화면의 개인 7일 busy calendar | 개인정보 보호상 제외; 요청자 전용 ephemeral/App Home에서만 선택 제공 |
| `/dev/users` 사용자 목록 | 운영 Slack 봇에서 사용 금지 |

### 15.10 MVP 최종 Definition of Done

Slack 봇 프론트엔드는 아래 시나리오가 모두 통과해야 핵심 기능 구현 완료로 본다.

1. 연결되지 않은 사용자가 `/meetu schedule`을 실행하면 개인 연결 안내만 받고 협상은 시작되지 않는다.
2. 연결된 사용자가 `/meetu init`을 실행하면 Calendar가 연결된 채널 멤버로 방이 정확히 한 번 생성된다.
3. 미연결 참가자가 한 명이라도 있으면 그 사용자를 명확히 알리고 방 생성 또는 협상을 차단한다.
4. `/meetu schedule <요청>` 한 번이 내부 메시지 한 건과 협상 한 건만 생성한다.
5. Slack 재전송 및 봇 프로세스 재시작 후에도 중복 메시지와 중복 협상이 없다.
6. 분석·Calendar 확인·협상·재검증 상태와 에이전트 발화가 올바른 Slack 스레드에 표시된다.
7. 성공 결과는 KST 확정 시간으로 표시되고 실제 Google Calendar 일정 생성과 일치한다.
8. 실패 결과는 이전 slot을 표시하지 않고 조건 변경 및 재시도 경로를 제공한다.
9. WebSocket 단절, Spring 오류, Google Calendar 오류 각각에 대해 입력·상태를 잃지 않고 복구하거나 명확한 실패를 알린다.
10. 어떤 공개 채널 메시지에도 개인별 busy time, OAuth 토큰, 이메일 등의 민감 정보가 노출되지 않는다.

## 16. 테스트 승인 기준

### 계약 테스트

- 모든 DTO가 실제 Spring JSON 필드명과 일치한다.
- `LocalDateTime`과 offset datetime을 구분해 파싱한다.
- `size=0`, `size=999`가 각각 1, 250으로 처리되는 서버 동작을 수용한다.
- REST 오류와 STOMP 오류를 Slack 사용자 문구로 변환한다.

### 멱등성과 순서

- 동일 Slack `event_id`가 여러 번 와도 내부 메시지와 Slack 답글이 한 번만 생성된다.
- 메시지 저장 확인 전에 협상을 시작하지 않는다.
- progress보다 result가 먼저 도착해도 최종 상태가 되돌아가지 않는다.
- 완료된 session의 늦은 agent event는 새 Slack 답글을 만들지 않는다.

### 연결 복구

- STOMP 단절 후 백오프로 재연결하고 네 큐를 모두 재구독한다.
- 재연결 중 Slack command는 수락 후 처리 지연을 안내한다.
- 상태 조회 API가 추가되면 누락된 최종 결과를 복구한다.

### 보안

- 잘못된 Slack 서명, 5분 초과 timestamp, 다른 teamId를 거부한다.
- 연결되지 않은 사용자와 채널은 내부 ID를 직접 지정할 수 없다.
- 서비스 토큰이 없거나 잘못되면 Spring 대리 호출이 거부된다.
- OAuth state는 1회 사용 후 폐기되고 만료된다.

### E2E 완료 조건

1. 두 명 이상의 사용자가 Slack과 Google Calendar 연결을 완료한다.
2. 채널에서 `/meetu init`이 내부 방 하나만 생성한다.
3. `/meetu schedule ...`이 메시지를 한 번 저장하고 협상을 한 번 시작한다.
4. 네 단계 진행 상태가 Slack 메시지에 반영된다.
5. 성공 시 모든 참가자의 Google Calendar에 일정이 생성되고 Slack에 KST 시간이 표시된다.
6. 공통 시간이 없거나 외부 오류가 나면 실패 상태와 재시도 UX가 표시된다.

## 17. 구현 시 주의할 현재 코드 특성

- Spring의 협상 콜백은 AI 발화를 실제 참가자 ID의 일반 채팅 메시지로도 저장한 뒤 별도 agent event를 만든다. 최근 메시지 REST는 내용 일치로 AI 발화를 걸러내므로 같은 내용의 사용자 메시지도 제외될 가능성이 있다.
- AI 콜백 중 `messages`와 `progress` 전달 실패는 협상 자체를 중단시키지 않는다. `result`는 최대 3회 재시도하지만 최종 실패 후 별도 복구 큐가 없다.
- AI 서버는 같은 `session_id` 재요청에도 새 LangGraph `thread_id`로 새 협상을 시작한다. Spring의 `retry(sessionId)`는 새 메시지가 생기면 같은 sessionId로 AI를 다시 호출하므로 중복/경쟁 가능성을 고려해야 한다.
- Spring Security는 현재 알림과 인증 API 외 대부분의 경로를 `permitAll`로 둔다. CORS는 브라우저 보호일 뿐 Slack 봇 서버 간 요청의 인증 수단이 아니다.
- 채팅방 생성 시 요청자를 포함한 모든 사용자의 Google authorized client가 있어야 한다. 단순히 users 테이블에 사용자가 존재하는 것만으로는 충분하지 않다.

## 18. 구현 기준 소스

본 명세의 현재 계약은 다음 구현을 기준으로 작성했다.

- Spring REST/WS: `backend/src/main/java/com/luckybiki/scheduler/chat`, `calendar`, `notification`
- Spring 보안/환경: `backend/src/main/resources/application.yaml`, `SecurityConfig.java`
- 기존 브라우저 클라이언트: `frontend/src/App.jsx`, `frontend/src/MeetUApp.jsx`
- AI 입출력: `luckivicki4-AI/app/api/routes.py`, `schemas.py`, `clients/backend.py`

코드와 문서가 충돌할 때는 배포된 서버의 계약 테스트 결과를 우선하고, 이 문서와 DTO 타입을 같은 변경에서 함께 갱신한다.

## 19. Slack 공식 참고 문서

- [Verifying requests from Slack](https://api.slack.com/authentication/verifying-requests-from-slack) — signing secret, raw body HMAC, 5분 replay 방지
- [Slash commands](https://api.slack.com/tutorials/your-first-slash-command) — 3초 응답 제한, `response_url`, payload 필드
- [Socket Mode](https://api.slack.com/apis/connections/socket-implement) — app-level token, 공개 Request URL 없는 연결, Marketplace 제한
- [Slack authentication and scopes](https://api.slack.com/authentication) — 토큰과 granular permission 개요
