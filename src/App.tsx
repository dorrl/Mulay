import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import './App.css'

type User = { id: string; name: string; avatar: string; admin: boolean }
type Track = { id: string; videoId: string; title: string; channel: string; thumbnail: string; likes: number; dislikes: number }
type Message = { id: string; userId: string; name: string; avatar: string; text: string; at: number }
type Room = { current: Track | null; queue: Track[]; startedAt: number | null; pausedAt: number | null; paused: boolean; announcement: { id: string; text: string; at: number } | null; chat: Message[] }
type Result = { videoId: string; title: string; channel: string; thumbnail: string }
type Player = { loadVideoById: (arg: { videoId: string; startSeconds?: number }) => void; seekTo: (seconds: number, ahead: boolean) => void; getCurrentTime: () => number; stopVideo: () => void; destroy: () => void }
type YTApi = { Player: new (element: HTMLElement, options: Record<string, unknown>) => Player; PlayerState: { PLAYING: number; BUFFERING: number; ENDED: number } }
declare global { interface Window { YT?: YTApi; onYouTubeIframeAPIReady?: () => void } }
const blank: Room = { current: null, queue: [], startedAt: null, pausedAt: null, paused: false, announcement: null, chat: [] }
const position = (room: Room) => room.paused && room.pausedAt ? room.pausedAt : room.startedAt ? Math.max(0, (Date.now() - room.startedAt) / 1000) : 0

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [googleConfigured, setGoogleConfigured] = useState(false)
  const [room, setRoom] = useState<Room>(blank)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [adminId, setAdminId] = useState('')
  const [activeUsers, setActiveUsers] = useState<User[]>([])
  const [notice, setNotice] = useState('')
  const [online, setOnline] = useState(false)
  const socket = useRef<Socket | null>(null)
  const player = useRef<Player | null>(null)
  const playerHost = useRef<HTMLDivElement>(null)
  const previousPlayerState = useRef<number | null>(null)
  const loadedVideo = useRef<string | null>(null)
  const currentRoom = useRef(room)
  currentRoom.current = room

  useEffect(() => {
    fetch('/api/me', { credentials: 'include' }).then((r) => r.json()).then((d) => { setUser(d.user); setGoogleConfigured(d.googleConfigured) }).catch(() => setNotice('서버에 연결할 수 없습니다.'))
    const s = io({ withCredentials: true, reconnection: true })
    socket.current = s
    s.on('connect', () => { setOnline(true); s.emit('sync:request') })
    s.on('disconnect', () => setOnline(false))
    s.on('connect_error', (e: Error) => { setOnline(false); if (e.message) setNotice(e.message) })
    s.on('room:state', (next: Room) => setRoom(next))
    s.on('chat:message', (m: Message) => setRoom((old) => ({ ...old, chat: [...old.chat.filter((x) => x.id !== m.id), m].slice(-100) })))
    s.on('room:announcement', (a: NonNullable<Room['announcement']>) => { setRoom((old) => ({ ...old, announcement: a })); setNotice('공지: ' + a.text) })
    s.on('playback:resynced', () => setNotice('재생 위치를 다시 동기화했어요.'))
    return () => { s.disconnect(); socket.current = null }
  }, [])

  useEffect(() => {
    if (!user?.admin) return
    const loadUsers = () => fetch('/api/admin/users', { credentials: 'include' }).then((r) => r.ok ? r.json() : null).then((data) => { if (data) setActiveUsers(data.activeUsers || []) }).catch(() => undefined)
    void loadUsers()
    const timer = window.setInterval(loadUsers, 10000)
    return () => window.clearInterval(timer)
  }, [user?.admin])

  useEffect(() => {
    if (!window.YT) {
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement('script')
        script.src = 'https://www.youtube.com/iframe_api'
        script.async = true
        document.head.appendChild(script)
      }
    }
    const init = () => {
      if (!window.YT || !playerHost.current || player.current) return
      player.current = new window.YT.Player(playerHost.current, {
        width: '100%', height: '100%', videoId: '',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: () => { loadedVideo.current = null },
          onStateChange: (event: { data: number; target: Player }) => {
            const states = window.YT?.PlayerState
            if (states && event.data === states.ENDED) {
              const ended = currentRoom.current.current
              if (ended) socket.current?.emit('playback:ended', { videoId: ended.videoId })
            }
            if (states && event.data === states.PLAYING && previousPlayerState.current === states.BUFFERING) {
              const current = currentRoom.current.current
              if (current) socket.current?.emit('playback:ad-resync', { videoId: current.videoId, currentTime: event.target.getCurrentTime() })
            }
            previousPlayerState.current = event.data
          },
          onAutoplayBlocked: () => setNotice('자동 재생이 차단됐어요. 플레이어의 재생 버튼을 눌러주세요.'),
          onError: () => setNotice('이 영상은 재생할 수 없습니다. 다른 영상을 추가해 주세요.'),
        },
      })
    }
    if (window.YT?.Player) init()
    else {
      const previous = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => { previous?.(); init() }
    }
    return () => { player.current?.destroy(); player.current = null }
  }, [])

  useEffect(() => {
    if (!player.current) return
    if (!room.current) { loadedVideo.current = null; player.current.stopVideo(); return }
    if (loadedVideo.current === room.current.videoId) return
    loadedVideo.current = room.current.videoId
    player.current.loadVideoById({ videoId: room.current.videoId, startSeconds: position(room) })
  }, [room.current?.videoId])

  useEffect(() => {
    if (!player.current || !room.current || !room.startedAt) return
    const expected = position(room)
    const timer = window.setTimeout(() => {
      try { const actual = player.current?.getCurrentTime(); if (actual !== undefined && Number.isFinite(actual) && Math.abs(actual - expected) > 2.5) player.current?.seekTo(expected, true) } catch { /* Player not ready yet. */ }
    }, 600)
    return () => window.clearTimeout(timer)
  }, [room.startedAt, room.paused, room.pausedAt])

  const search = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!query.trim()) return
    setSearching(true); setSearchError(''); setResults([])
    try {
      const response = await fetch('/api/search?q=' + encodeURIComponent(query.trim()))
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '검색에 실패했습니다.')
      setResults(data.items)
      if (!data.items.length) setSearchError('검색 결과가 없습니다.')
    } catch (e) { setSearchError(e instanceof Error ? e.message : '검색에 실패했습니다.') }
    finally { setSearching(false) }
  }
  const add = (track: Result) => {
    if (!user) { setNotice('영상을 추가하려면 Google 로그인이 필요해요.'); return }
    socket.current?.emit('queue:add', track, (r: { ok: boolean; error?: string }) => {
      setNotice(r.ok ? '대기열에 추가했어요.' : r.error || '추가하지 못했어요.')
      if (r.ok) setResults((old) => old.filter((x) => x.videoId !== track.videoId))
    })
  }
  const vote = (track: Track, value: 1 | -1) => {
    if (!user) { setNotice('투표하려면 로그인이 필요해요.'); return }
    socket.current?.emit('queue:vote', { trackId: track.id, vote: value }, (r: { ok: boolean; error?: string }) => { if (!r.ok) setNotice(r.error || '투표 실패') })
  }
  const sendChat = (event: React.FormEvent) => {
    event.preventDefault()
    if (!chatInput.trim()) return
    socket.current?.emit('chat:send', chatInput, (r: { ok: boolean; error?: string }) => { if (r.ok) setChatInput(''); else setNotice(r.error || '채팅 실패') })
  }
  const admin = (command: Record<string, string>) => socket.current?.emit('admin:command', command, (r: { ok: boolean; error?: string }) => setNotice(r.ok ? '관리자 명령을 실행했어요.' : r.error || '명령 실패'))
  const logout = async () => { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); setUser(null); window.location.reload() }

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/"><span className="brand-mark">m</span><span>mulay</span></a><div className="topbar-right"><span className={'connection ' + (online ? 'is-online' : '')}><i />{online ? '실시간 연결됨' : '연결 중'}</span>{user ? <div className="user-chip">{user.avatar && <img src={user.avatar} alt="" />}<span>{user.name}</span><button className="text-button" onClick={logout}>로그아웃</button></div> : <a className="login-button" href="/auth/google" title={!googleConfigured ? 'Google OAuth 설정 필요' : undefined}><b>G</b> Google 로그인</a>}</div></header>
    <main>
      <section className="intro"><div className="eyebrow"><span className="live-dot" /> ONE ROOM, ONE PLAYLIST</div><h1>지금, 함께 듣는 음악</h1><p>좋아하는 노래를 더하고, 같은 순간을 나눠요.</p></section>
      {room.announcement && <div className="announcement"><span>공지</span><p>{room.announcement.text}</p></div>}
      {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="알림 닫기">×</button></div>}
      <section className="player-card"><div className="player-frame"><div ref={playerHost} id="youtube-player" />{!room.current && <div className="player-empty"><span className="empty-icon">♫</span><strong>아직 재생 중인 노래가 없어요</strong><span>검색해서 첫 번째 곡을 추가해 보세요.</span></div>}</div><div className="now-playing"><div className="now-label"><span className="equalizer"><i /><i /><i /></span> NOW PLAYING</div><div className="track-title">{room.current?.title || '재생 대기 중'}</div><div className="track-subtitle">{room.current?.channel || '함께 들을 노래를 기다리고 있어요'}</div><div className="playback-meta"><span>{room.paused ? '일시정지' : room.current ? '공동 재생 중' : '대기 중'}</span><span>·</span><span>{room.queue.length}곡 대기</span></div>{user?.admin && <div className="admin-playback"><button onClick={() => admin({ action: 'skip' })}>다음 곡</button><button onClick={() => admin({ action: 'stop' })}>재생 중단</button></div>}</div></section>
      <section className="search-section"><div className="section-heading"><div><span className="section-kicker">DISCOVER</span><h2>어떤 노래를 들을까요?</h2></div><span className="muted small">YouTube에서 검색</span></div><form className="search-form" onSubmit={search}><span className="search-icon">⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="노래 제목, 아티스트 검색" maxLength={100} /><button type="submit" disabled={searching}>{searching ? '검색 중…' : '검색'}</button></form>{searchError && <p className="inline-message">{searchError}</p>}{results.length > 0 && <div className="search-results">{results.map((track) => <article className="result-row" key={track.videoId}><img src={track.thumbnail} alt="" /><div className="result-info"><strong>{track.title}</strong><span>{track.channel}</span></div><button className="add-button" onClick={() => add(track)}>＋ 추가</button></article>)}</div>}</section>
      <div className="lower-grid"><section className="queue-section panel"><div className="section-heading"><div><span className="section-kicker">UP NEXT</span><h2>대기열 <span className="count">{room.queue.length}</span></h2></div></div>{!room.queue.length ? <div className="empty-list">대기 중인 노래가 없어요.<br />첫 곡을 추천해 주세요.</div> : <div className="queue-list">{room.queue.map((track, index) => <article className="queue-row" key={track.id}><span className="queue-index">{String(index + 1).padStart(2, '0')}</span><img src={track.thumbnail} alt="" /><div className="queue-info"><strong>{track.title}</strong><span>{track.channel}</span></div><div className="vote-actions"><button title="좋아요" onClick={() => vote(track, 1)}>↑ <span>{track.likes}</span></button><button title="싫어요" onClick={() => vote(track, -1)}>↓ <span>{track.dislikes}</span></button></div></article>)}</div>}</section>
      <section className="chat-section panel"><div className="section-heading"><div><span className="section-kicker">SAY HELLO</span><h2>채팅</h2></div><span className="chat-status"><i /> LIVE</span></div><div className="chat-messages">{room.chat.map((m) => <div className="chat-message" key={m.id}>{m.avatar ? <img src={m.avatar} alt="" /> : <span className="avatar-fallback">{m.name.slice(0, 1)}</span>}<div className="chat-copy"><div><strong>{m.name}</strong><time>{new Date(m.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{m.text}</p></div></div>)}</div><form className="chat-form" onSubmit={sendChat}><input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder={user ? '메시지를 입력하세요…' : '로그인 후 채팅할 수 있어요'} maxLength={500} disabled={!user} /><button type="submit" disabled={!user || !chatInput.trim()} aria-label="채팅 보내기">↗</button></form></section></div>
      {user?.admin && <section className="admin-panel panel"><div className="section-heading"><div><span className="section-kicker">MODERATION</span><h2>관리자 도구</h2></div><span className="admin-tag">ADMIN</span></div><div className="admin-tools"><form onSubmit={(e) => { e.preventDefault(); if (adminId.trim()) admin({ action: 'ban', userId: adminId.trim() }) }}><label>사용자 ID 차단</label><div className="admin-inline"><select value={adminId} onChange={(e) => setAdminId(e.target.value)}><option value="">접속자 선택 ({activeUsers.length}명)</option>{activeUsers.map((active) => <option key={active.id} value={active.id}>{active.name} · {active.id}</option>)}</select><input value={adminId} onChange={(e) => setAdminId(e.target.value)} placeholder="또는 Google 사용자 ID 입력" /><button>차단</button><button type="button" className="secondary-button" onClick={() => admin({ action: 'unban', userId: adminId.trim() })}>차단 해제</button></div></form><form onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; const text = new FormData(f).get('announcement')?.toString().trim(); if (text) { admin({ action: 'announce', text }); f.reset() } }}><label>전체 공지</label><div className="admin-inline"><input name="announcement" maxLength={500} placeholder="모든 접속자에게 보낼 공지" /><button>공지 보내기</button></div></form></div></section>}
      <footer><span>mulay <b>·</b> 음악으로 연결되는 공간</span><span>각 영상은 YouTube 공식 플레이어로 재생됩니다.</span></footer>
    </main>
  </div>
}
