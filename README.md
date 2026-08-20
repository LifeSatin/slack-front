# Meet:U Slack Bot

Meet:U는 Slack 채널 참여자들의 Google Calendar 일정을 조율하는 서버형 Slack 앱입니다. 사용자는 `/meetu schedule ...`로 요청하고, 봇은 분석·캘린더 확인·협상·확정 과정을 같은 채널에 표시합니다.

이 문서는 Slack 앱을 처음 만드는 사람이 자신의 테스트 워크스페이스에 앱을 설치하고 로컬 PC에서 실행·검증하는 전 과정을 설명합니다. 처음에는 공개 서버가 필요 없는 **Socket Mode**를 사용합니다.

> 이 저장소는 Slack 프론트엔드 어댑터입니다. `/meetu help`와 Slack 연결 자체는 이 저장소만으로 확인할 수 있지만, `connect → init → schedule` 전체 시나리오에는 별도의 Spring Boot 백엔드, AI 서버, Google OAuth 설정이 필요합니다.

## 1. 용어와 준비물

- **워크스페이스**: 사람들이 채널에서 대화하는 하나의 Slack 공간
- **Slack 앱/봇**: 워크스페이스에 설치되는 Meet:U 기능과 봇 사용자
- **Bot Token (`xoxb-`)**: 봇의 Slack API 호출에 쓰는 비밀 값
- **App Token (`xapp-`)**: Socket Mode 연결에 쓰는 비밀 값
- **Signing Secret**: Slack 요청의 진위를 검증하는 비밀 값
- **Slash Command**: 메시지 입력창에서 실행하는 `/meetu` 같은 명령

다음 항목이 필요합니다.

1. 앱을 설치할 수 있는 Slack 워크스페이스
2. Windows, macOS 또는 Linux PC
3. Node.js 22.5 이상과 npm
4. 이 프로젝트 폴더
5. 전체 조율을 시험하려면 실행 중인 Spring Boot 백엔드와 AI 서버

회사 워크스페이스는 앱 설치에 관리자 승인이 필요할 수 있습니다. 처음에는 실제 업무 공간 대신 별도의 개발 워크스페이스나 Slack 개발 샌드박스를 권장합니다.

```powershell
node --version
npm --version
```

Node 버전은 `v22.5.0` 이상이어야 합니다. 이 프로젝트는 Node 내장 SQLite를 사용합니다.

토큰과 Signing Secret은 비밀번호처럼 취급하세요. Git, 화면 공유, 로그 또는 채팅에 노출했다면 Slack 설정에서 즉시 폐기하고 다시 발급해야 합니다.

## 2. Slack 앱 만들기

### 2.1 새 앱 생성

1. [Slack 앱 관리 페이지](https://api.slack.com/apps)를 엽니다.
2. **Create New App → From scratch**를 선택합니다.
3. App Name에 `Meet:U Dev`처럼 개발용임을 알 수 있는 이름을 입력합니다.
4. 테스트할 워크스페이스를 선택하고 **Create App**을 누릅니다.

`slack-manifest.yaml`은 운영용 HTTP 설정의 출발점입니다. 첫 검증에는 URL placeholder를 수정할 필요가 없는 아래 수동 Socket Mode 절차가 더 쉽습니다.

### 2.2 봇 권한 추가

왼쪽 메뉴의 **OAuth & Permissions → Scopes → Bot Token Scopes**에 다음 권한을 추가합니다.

| Scope | 용도 |
|---|---|
| `commands` | `/meetu` 명령 수신 |
| `chat:write` | 진행 상태와 결과 작성 |
| `users:read` | 봇·삭제 사용자 여부 확인 |
| `channels:read` | 공개 채널 멤버 확인 |
| `groups:read` | 비공개 채널 멤버 확인 |

이 MVP는 일반 채널 대화를 자동 수집하지 않으므로 `channels:history`와 `groups:history`는 필요하지 않습니다.

### 2.3 Socket Mode와 App Token 활성화

Socket Mode에서는 로컬 PC가 Slack으로 WebSocket 연결을 시작하므로 포트 포워딩이나 ngrok 같은 공개 터널이 필요 없습니다.

1. **Settings → Socket Mode**에서 **Enable Socket Mode**를 켭니다.
2. 토큰 이름을 `local-development`로 정합니다.
3. `connections:write` scope를 추가하고 생성합니다.
4. `xapp-`으로 시작하는 값을 복사합니다. 이것이 `SLACK_APP_TOKEN`입니다.

이미 Socket Mode를 켰다면 **Settings → Basic Information → App-Level Tokens → Generate Token and Scopes**에서도 토큰을 만들 수 있습니다.

### 2.4 `/meetu` 명령 생성

1. **Slash Commands → Create New Command**를 누릅니다.
2. Command: `/meetu`
3. Short Description: `Meet:U 일정 조율`
4. Usage Hint: `help | connect | status | init | sync | schedule | retry`
5. **Save**를 누릅니다.

Socket Mode에서는 공개 Request URL이 필요하지 않습니다. 화면이 URL을 요구한다면 Socket Mode를 먼저 활성화한 뒤 돌아오세요.

### 2.5 버튼 동작과 앱 설치

1. 실패 결과의 재시도 버튼을 받도록 **Interactivity & Shortcuts**에서 Interactivity를 켭니다. Socket Mode에서는 Request URL이 필요하지 않습니다.
2. **Install App → Install to Workspace**를 누릅니다.
3. 권한을 확인하고 **Allow**를 누릅니다.
4. 설치 후 `xoxb-`으로 시작하는 **Bot User OAuth Token**을 복사합니다.

권한을 나중에 바꿨다면 앱을 워크스페이스에 **Reinstall**해야 합니다.

### 2.6 Signing Secret과 Team ID

- **Settings → Basic Information → App Credentials → Signing Secret → Show**에서 값을 복사합니다.
- 선택 사항인 Team ID는 Slack 웹 URL의 `/client/T.../` 부분에서 확인할 수 있습니다. 설정하면 다른 워크스페이스의 요청을 거부합니다. 첫 실행에서는 비워 둘 수 있습니다.

## 3. 프로젝트 설치와 환경 설정

PowerShell에서 다음을 실행합니다.

```powershell
cd C:\Users\admin\Documents\ChatGPT\slack-front
npm install
Copy-Item .env.example .env
```

macOS/Linux에서는 마지막 명령 대신 `cp .env.example .env`를 사용합니다.

`.env`를 열어 최소한 다음 값을 실제 Slack 앱 값으로 교체합니다.

```dotenv
SLACK_BOT_TOKEN=xoxb-실제-Bot-Token
SLACK_SIGNING_SECRET=실제-Signing-Secret
SLACK_APP_TOKEN=xapp-실제-App-Token
SLACK_SOCKET_MODE=true
```

전체 설정은 다음과 같습니다.

| 환경 변수 | 설명 |
|---|---|
| `SLACK_BOT_TOKEN` | 설치 후 받은 `xoxb-...`, 필수 |
| `SLACK_SIGNING_SECRET` | Basic Information의 Signing Secret, 필수 |
| `SLACK_APP_TOKEN` | `connections:write`를 가진 `xapp-...`, Socket Mode 필수 |
| `SLACK_SOCKET_MODE` | 로컬 검증은 `true` |
| `SLACK_TEAM_ID` | 허용할 `T...` 워크스페이스 ID, 선택 |
| `PORT` | HTTP Events API 모드의 수신 포트, 기본 `3000` |
| `BACKEND_BASE_URL` | Spring REST 주소, 기본 `http://localhost:8080` |
| `BACKEND_WS_URL` | Spring STOMP 주소, 기본 `ws://localhost:8080/ws/chat` |
| `BACKEND_SERVICE_TOKEN` | Spring과 합의한 내부 서비스 토큰 |
| `PUBLIC_BASE_URL` | OAuth callback 기준 URL, 로컬은 `http://localhost:3000` |
| `DATABASE_PATH` | 매핑·멱등성 DB, 기본 `./data/meetu.sqlite` |
| `OAUTH_STATE_TTL_SECONDS` | 연결 링크 유효 시간, 기본 600초 |
| `MESSAGE_CONFIRM_TIMEOUT_MS` | 메시지 저장 확인 제한, 기본 10초 |

`.env`는 `.gitignore`에 포함되어 있지만 커밋 전에 다시 확인하세요.

## 4. 코드 검증과 실행

먼저 빌드와 자동 테스트를 수행합니다.

```powershell
npm run typecheck
npm test
npm audit --audit-level=high
```

정상이라면 TypeScript 오류와 실패 테스트가 없어야 합니다. 테스트는 OAuth state 1회성, 멱등성, 방별 활성 협상, 재시작 데이터, 이벤트 중복 및 순서 역전을 검사합니다.

개발 모드로 실행합니다.

```powershell
npm run dev
```

다음 문구가 나오면 Slack 연결이 시작된 것입니다.

```text
Meet:U Slack bot started (Socket Mode)
```

터미널을 닫으면 봇도 중지됩니다. 빌드 결과를 직접 실행하려면 `npm run build` 후 `npm start`를 사용합니다.

## 5. 자신의 Slack에서 검증

### 5.1 앱을 채널에 초대

테스트 채널을 만들고 다음을 실행합니다.

```text
/invite @Meet:U Dev
```

앱 이름이 다르면 자동 완성에서 해당 앱을 선택합니다. 비공개 채널에서는 봇이 채널 멤버여야 메시지를 쓸 수 있습니다.

### 5.2 백엔드 없이 가능한 검증

```text
/meetu help
```

명령 사용법이 실행한 사용자에게만 보이는 ephemeral 메시지로 표시되어야 합니다.

```text
/meetu status
```

연결 전에는 `Google Calendar 연결이 필요해요.`라는 안내가 나와야 합니다.

```text
/meetu connect
```

Calendar 연결 버튼이 실행한 사용자에게만 보여야 합니다. 링크의 state는 10분 동안 유효하고 한 번만 사용할 수 있습니다. Spring 백엔드가 없다면 버튼 클릭 후 `localhost:8080` 연결 오류가 나는 것이 현재 구조에서는 정상입니다.

### 5.3 전체 E2E 검증에 필요한 서버 조건

`connect → init → schedule`을 완료하려면 다음이 모두 준비되어야 합니다.

1. Spring이 `BACKEND_BASE_URL`과 `BACKEND_WS_URL`에서 실행 중이어야 합니다.
2. Google OAuth 성공 후 Spring이 `PUBLIC_BASE_URL/oauth/callback?state=...&internalUserId=...`로 반환해야 합니다.
3. Spring REST는 `X-Internal-Token`, STOMP는 `serviceToken`을 검증해야 합니다.
4. 채널 사용자마다 Slack↔내부 사용자 연결과 Calendar 권한이 있어야 합니다.
5. 연결된 실제 사용자가 최소 2명이어야 합니다.
6. AI 서버가 Spring 협상 요청과 callback을 처리해야 합니다.

Spring OAuth callback이 아직 구현되지 않았다면 `/meetu connect` 이후 단계는 진행할 수 없습니다. Slack ID를 내부 ID로 임의 지정하는 운영 우회 방법은 보안상 제공하지 않습니다.

### 5.4 계정 연결

채널 참가자 각자가 다음을 실행하고 자신의 Google 계정으로 로그인합니다.

```text
/meetu connect
```

완료되면 Slack DM으로 성공 메시지가 와야 합니다. 다음 명령에서 `계정: 연결됨`을 확인합니다.

```text
/meetu status
```

### 5.5 채널 초기화

```text
/meetu init 제품팀 테스트
```

확인할 항목:

- 봇·삭제 사용자는 참가자에서 제외됩니다.
- 미연결 사용자가 있으면 멘션하고 방 생성을 중단합니다.
- 연결된 실제 사용자가 2명 이상이면 내부 room이 한 번 생성됩니다.
- 같은 채널에서 다시 실행해도 새 room을 만들지 않습니다.
- `/meetu status`에 room 번호가 표시됩니다.

### 5.6 일정 조율

```text
/meetu schedule 다음 주 화요일이나 수요일 오후에 1시간 회고 회의 잡아줘
```

정상 흐름:

1. 요청 접수 ephemeral 메시지가 즉시 나타납니다.
2. 채널에 `📅 일정 조율을 시작했어요.` 메시지가 생깁니다.
3. 상태가 `분석 → Calendar 확인 → 협상 → 재검증` 순으로 같은 메시지에서 갱신됩니다.
4. AI 발화는 해당 메시지의 스레드 답글로 나타납니다.
5. 성공하면 KST 확정 시간이 표시되고 Google Calendar에 일정이 생성됩니다.
6. 실패하면 실패 문구와 **다시 요청하기** 버튼이 표시됩니다.

개인별 busy time, 이메일, OAuth 토큰이 공개 채널에 표시되면 안 됩니다.

### 5.7 멱등성과 복구 수동 검사

- 같은 `/meetu init`을 두 번 실행해 room이 하나인지 확인합니다.
- 조율 중 새 `/meetu schedule`을 실행해 두 번째 협상이 차단되는지 확인합니다.
- 실패 후 `/meetu retry` 또는 버튼으로 한 건만 재시작되는지 확인합니다.
- 협상 중 `Ctrl+C`로 종료했다가 다시 실행해 STOMP 구독이 복원되는지 확인합니다.
- Slack 재전송에도 내부 메시지와 결과 답글이 중복되지 않는지 서버 로그와 DB로 확인합니다.

SQLite 상태는 `data/meetu.sqlite`에 보존됩니다. 내부 사용자·채널 매핑이 있으므로 외부에 공유하지 마세요. 정리하려면 먼저 봇을 종료하고 백업 정책을 확인하세요.

## 6. 자주 발생하는 문제

### `/meetu`가 나타나지 않음

- Slash Commands에 `/meetu`가 생성됐는지 확인합니다.
- 앱을 워크스페이스에 설치했는지 확인합니다.
- 권한이나 명령을 변경했다면 앱을 다시 설치합니다.

### Socket Mode 또는 `SLACK_APP_TOKEN` 오류

- App Token이 `xapp-`으로 시작하는지 확인합니다.
- App-Level Token에 `connections:write`가 있는지 확인합니다.
- Socket Mode가 켜져 있고 `.env`가 `SLACK_SOCKET_MODE=true`인지 확인합니다.

### `invalid_auth`, `not_authed`, `token_revoked`

`SLACK_BOT_TOKEN`에 `xapp-`이 아니라 `xoxb-` Bot User OAuth Token을 넣었는지 확인합니다. 토큰을 다시 발급했다면 `.env`를 바꾸고 프로세스를 재시작합니다.

### `missing_scope`

OAuth & Permissions에서 오류가 지목한 Bot Token Scope를 추가하고 앱을 다시 설치합니다.

### `channel_not_found` 또는 메시지 작성 실패

- `/invite @앱이름`으로 봇을 채널에 초대합니다.
- 비공개 채널에는 명시적으로 초대해야 합니다.
- `chat:write`, `channels:read`, `groups:read`를 확인합니다.

### 계속 “연결 필요”라고 표시됨

- Spring OAuth callback 계약이 구현됐는지 확인합니다.
- state의 기본 유효 시간 10분이 지나지 않았는지 확인합니다.
- `DATABASE_PATH`가 실행마다 다른 파일을 가리키지 않는지 확인합니다.

### `/meetu init`에서 사용자가 미연결로 표시됨

채널의 모든 실제 참여자가 각자 `/meetu connect`를 완료해야 합니다. 이메일만으로 자동 연결하지 않습니다.

### 일정 요청 전달 실패

- Spring이 `BACKEND_BASE_URL`에서 응답하는지 확인합니다.
- STOMP endpoint와 `BACKEND_WS_URL`이 일치하는지 확인합니다.
- Spring과 봇의 서비스 토큰이 같은지 확인합니다.
- 봇은 지수 백오프+jitter로 STOMP를 다시 연결하지만 Calendar 오류를 무한 재시도하지 않습니다.

### 포트 3000이 사용 중

Socket Mode의 OAuth/health 보조 서버는 현재 Bolt 설정상 3000번 포트를 사용합니다. 먼저 3000번 포트를 사용 중인 다른 개발 서버를 종료한 뒤 Meet:U를 다시 실행하세요. `PORT` 변경은 `SLACK_SOCKET_MODE=false`인 HTTP Events API 모드에 적용됩니다. HTTP 모드에서 포트를 바꿀 때는 다음 두 값을 함께 변경합니다.

```dotenv
PORT=3001
PUBLIC_BASE_URL=http://localhost:3001
```

## 7. 운영 HTTP 배포로 전환

로컬 검증에는 Socket Mode가 편리하지만 공개 Marketplace 배포에는 HTTP Events API를 사용해야 합니다.

1. TLS가 적용된 공개 서버에 배포합니다.
2. `SLACK_SOCKET_MODE=false`로 변경합니다.
3. `PUBLIC_BASE_URL=https://bot.example.com`처럼 설정합니다.
4. Slash Command와 Interactivity Request URL을 `https://bot.example.com/slack/events`로 지정합니다.
5. `slack-manifest.yaml`의 `YOUR_PUBLIC_HOST`를 실제 호스트로 교체합니다.
6. 토큰은 배포 플랫폼의 Secret Manager에 저장합니다.
7. Spring/AI 내부 callback과 서비스 인증을 활성화합니다.
8. health check는 `GET /healthz`를 사용합니다.

공식 안내: [Bolt Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/), [Bolt JavaScript 앱 생성](https://docs.slack.dev/tools/bolt-js/creating-an-app/), [Slack App Manifest](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/).

## 8. 구현 범위와 도움 요청

명세 준수 현황은 `COMPLIANCE.md`에 정리되어 있습니다. 특히 인증된 OAuth callback, Spring REST/STOMP 서버 인증, 협상 상태 조회, 방 멤버 수정, Calendar event URL은 이 저장소 밖의 서버 변경이 필요합니다.

문제를 보고할 때 토큰이나 메시지 본문을 첨부하지 말고 `teamId`, `channelId`, `roomId`, `sessionId`, 화면에 표시된 추적 ID만 공유하세요.
