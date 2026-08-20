# 명세 준수 현황

기준 문서: `SLACK_BOT_FRONTEND_SPEC.md` (2026-08-20)

## 구현 완료

- Bolt HTTP Events API / Socket Mode, Slack 서명 및 replay 검증(Bolt 기본 미들웨어), 즉시 `ack`
- `/meetu help`, `connect`, `status`, `init`, `sync` 상태 비교 안내, `schedule`, `retry`
- 10분 만료 및 1회용 OAuth state, Slack 사용자↔내부 사용자 SQLite 매핑
- Slack 채널↔내부 room의 고유·영속 매핑, 봇/삭제 사용자 제외, 미연결 멤버 차단
- 2,000자 검증과 Slack mrkdwn 정규화, Slack 요청 기반 결정적 UUID
- STOMP 메시지 저장 confirmation 이후에만 협상 REST 호출
- 네 STOMP queue 구독, heartbeat, 지수 백오프+jitter, 재구독
- 부모 메시지 progress 갱신, agent thread 답글, KST 성공 결과와 실패/retry Block Kit
- 방별 단일 active 협상, session 연결, result/agent 중복 제거, result 순서 역전 보호
- 활성 협상 영속화 및 프로세스 재시작 후 STOMP 구독 복원
- 워크스페이스 제한 옵션, 서비스 토큰 전달, 비밀/본문 비로깅

## Spring/AI 서버 계약 추가 후 E2E 가능한 항목

명세 13장의 P0 항목은 이 저장소 밖의 서버 변경이므로 어댑터 경계까지만 구현되어 있습니다.

- Spring OAuth가 성공 후 `/oauth/callback?state=...&internalUserId=...`로 서명되거나 내부 인증된 결과를 반환해야 함
- Spring이 `X-Internal-Token` 및 STOMP `serviceToken`을 실제 검증해야 함
- `POST /negotiations`가 `sessionId`를 반환하고 상태 조회 API를 제공해야 재시작 중 누락 결과까지 복구 가능
- 방 멤버 수정 API가 있어야 `/meetu sync`의 추가/삭제 적용 가능
- Calendar event URL이 결과에 포함되어야 “Google Calendar에서 열기” 버튼 제공 가능

## 검증

`npm test`는 빌드 후 다음을 검증합니다: OAuth state 1회성, 요청/채널 멱등성, 방별 active 제약, 전달 실패 잠금 해제, 재시작 복원 데이터, 결정적 UUID, Slack text 정규화, 중복 result 차단, result-before-progress, 완료 후 늦은 agent event 무시.
