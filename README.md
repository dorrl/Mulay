# Mulay

실시간 공동 음악방 MVP입니다. React + Vite + TypeScript 프런트엔드, Express + Socket.IO 서버, YouTube 공식 IFrame Player API를 사용합니다.

## 기능

- YouTube Data API v3 검색 및 공식 iframe 플레이어
- Socket.IO를 통한 현재 영상·대기열·채팅·공지 동기화
- 동일 YouTube 영상의 추가 제한: 마지막 추가 이후 6시간
- 영상별 좋아요·싫어요(계정당 투표 1개)
- Google OAuth 로그인 및 세션 쿠키
- 관리자: 사용자 차단/차단 해제, 전체 공지, 재생 중단, 다음 곡
- JSON 파일로 방 상태 저장, SQLite로 로그인 세션 저장
- 재접속 시 방 상태 재동기화

## 시작하기

Node.js 20.19+ 또는 22.12+ 권장.

```bash
npm install
cp .env.example .env
```

`.env`에 다음 값을 설정합니다.

1. `SESSION_SECRET`: `openssl rand -base64 48`로 생성한 긴 임의 문자열
2. Google Cloud Console에서 OAuth 2.0 웹 클라이언트 생성. 개발용 승인된 리디렉션 URI는 `http://localhost:3001/auth/google/callback`
3. YouTube Data API v3를 활성화하고 API 키를 `YOUTUBE_API_KEY`에 입력
4. 관리자 계정은 `ADMIN_EMAILS`에 Google 계정 이메일을 쉼표로 구분해 입력합니다. 필요하면 Google 프로필 ID를 `ADMIN_GOOGLE_IDS`에 입력할 수도 있습니다.

실행:

```bash
npm run dev
```

Vite는 `http://localhost:5173`, API와 Socket.IO 서버는 `http://localhost:3001`에서 실행됩니다. Google OAuth를 설정하기 전에도 화면은 열리지만 로그인·검색은 작동하지 않습니다.

프로덕션 빌드:

```bash
npm run build
npm start
```

빌드 결과물 `dist`는 Express가 제공하며, API/Socket.IO와 같은 출처로 운영할 수 있습니다. TLS(HTTPS)는 리버스 프록시에서 종료하고, 프록시를 사용하는 경우에만 `TRUST_PROXY=true`로 설정하세요. 프로덕션에서는 반드시 강력한 `SESSION_SECRET`과 `NODE_ENV=production`을 설정해야 합니다.

## 저장 데이터

- `data/room.json`: 현재 재생, 대기열, 영상 추가 이력(6시간 제한), 투표, 공지, 차단 사용자, 최근 채팅
- `data/sessions.sqlite`: 로그인 세션

`data/`와 `.env`는 버전 관리에 올리지 마세요. JSON 파일은 단일 인스턴스 MVP용입니다. 다중 서버로 확장할 때는 PostgreSQL과 공유 Socket.IO 어댑터로 교체해야 합니다.

## 동기화 및 광고 관련 한계

서버가 `startedAt`(Unix milliseconds)을 보관하고 클라이언트는 그 값으로 예상 재생 위치를 계산합니다. 접속 직후와 상태 변경 후 위치를 맞추며, 플레이어가 버퍼링 상태에서 재생 상태로 돌아오면 광고 종료/버퍼링 복귀 가능성으로 보고 현재 위치를 서버에 알려 기준 시각을 다시 맞춥니다.

YouTube IFrame API는 광고 전용의 신뢰할 수 있는 종료 이벤트를 제공하지 않습니다. 따라서 이 복귀 감지는 휴리스틱이며 일반 버퍼링에서도 동작할 수 있습니다. 각 시청자에게 광고 길이가 다르면 완벽하게 같은 시점으로 맞출 수 없고, 브라우저 자동재생 정책 때문에 첫 재생은 사용자의 클릭이 필요할 수 있습니다. 영상 종료는 서버에 전달되어 대기열의 다음 곡으로 넘어갑니다.

## 보안 메모

- OAuth 비밀키, 세션 비밀키, YouTube API 키는 서버 환경변수에만 보관합니다.
- 세션 쿠키는 HttpOnly/SameSite=Lax이며 프로덕션에서는 Secure입니다.
- Socket.IO 연결은 로그인 세션을 검사하며, 관리자 명령은 서버에서 권한을 확인합니다.
- 사용자 입력은 길이와 형식을 검증하고 HTTP 요청에는 rate limit을 적용합니다.
- 공개 서비스 전에는 HTTPS, OAuth 승인 도메인, 백업/복구, 채팅·Socket 이벤트별 추가 rate limit, 로그 정책을 검토하세요.
- YouTube 임베드가 허용되지 않는 영상이나 정책/저작권 제한이 있는 영상은 재생되지 않을 수 있습니다. 공식 플레이어를 사용한다고 해서 공동 음악방의 운영 방식 전체가 자동으로 사용 허가되는 것은 아닙니다.
