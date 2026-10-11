import { useEffect, useRef, useState, type FormEvent } from 'react'
import { io, type Socket } from 'socket.io-client'
import './App.css'

type User = {
  id: string
  name: string
  avatar: string
  admin: boolean
}

type Track = {
  id: string
  videoId: string
  title: string
  channel: string
  thumbnail: string
  durationSeconds?: number
  likes: number
  dislikes: number
  addedByName?: string
  addedByAvatar?: string
}

type Message = {
  id: string
  userId?: string
  name: string
  avatar: string
  text: string
  at: number
  admin?: boolean
  senderSocketId?: string
}

type Room = {
  current: Track | null
  queue: Track[]
  startedAt: number | null
  pausedAt: number | null
  paused: boolean
  announcement: { id: string; text: string; at: number } | null
  chat: Message[]
}

type Result = {
  videoId: string
  title: string
  channel: string
  thumbnail: string
  durationSeconds: number
}

type Player = {
  loadVideoById?: (arg: { videoId: string; startSeconds?: number }) => void
  seekTo?: (seconds: number, allowSeekAhead: boolean) => void
  getCurrentTime?: () => number
  getDuration?: () => number
  getPlaybackRate?: () => number
  setPlaybackRate?: (rate: number) => void
  getPlayerState?: () => number
  getVolume?: () => number
  setVolume?: (volume: number) => void
  playVideo?: () => void
  pauseVideo?: () => void
  stopVideo?: () => void
  destroy?: () => void
}

type PlayerEvent = { data: number; target: Player }

type YTApi = {
  Player: new (element: HTMLElement, options: Record<string, unknown>) => Player
  PlayerState: {
    UNSTARTED: number
    ENDED: number
    PLAYING: number
    PAUSED: number
    BUFFERING: number
    CUED: number
  }
}

declare global {
  interface Window {
    YT?: YTApi
    onYouTubeIframeAPIReady?: () => void
  }
}

const blank: Room = {
  current: null,
  queue: [],
  startedAt: null,
  pausedAt: null,
  paused: false,
  announcement: null,
  chat: [],
}

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

const position = (room: Room): number => {
  if (room.paused && room.pausedAt !== null) return room.pausedAt
  if (room.startedAt === null) return 0
  return Math.max(0, (Date.now() - room.startedAt) / 1000)
}

const applyRoomToPlayer = (
  player: Player | null,
  ready: boolean,
  room: Room,
  loadedVideo: { current: string | null },
  pendingVideoSync: { current: string | null },
): void => {
  if (!player || !ready) return

  if (!room.current) {
    loadedVideo.current = null
    player.stopVideo?.()
    return
  }

  const targetPosition = position(room)
  if (loadedVideo.current !== room.current.videoId) {
    if (typeof player.loadVideoById !== 'function') return
    loadedVideo.current = room.current.videoId
    pendingVideoSync.current = room.current.videoId
    player.loadVideoById({
      videoId: room.current.videoId,
      startSeconds: targetPosition,
    })
    if (room.paused) player.pauseVideo?.()
    return
  }

  player.seekTo?.(targetPosition, true)
  if (room.paused) player.pauseVideo?.()
}

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
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [localPaused, setLocalPaused] = useState(false)
  const [volume, setVolume] = useState(() => {
    const savedVolume = window.localStorage.getItem('mulay-volume')
    if (savedVolume === null) return 70
    const parsedVolume = Number(savedVolume)
    return Number.isFinite(parsedVolume) ? Math.min(100, Math.max(0, parsedVolume)) : 70
  })
  const [playbackTime, setPlaybackTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const localPausedRef = useRef(false)
  const manualPauseRef = useRef(false)
  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const socket = useRef<Socket | null>(null)
  const player = useRef<Player | null>(null)
  const playerReady = useRef(false)
  const playerHost = useRef<HTMLDivElement>(null)
  const loadedVideo = useRef<string | null>(null)
  const pendingVideoSync = useRef<string | null>(null)
  const awaitingSync = useRef(false)
  const currentRoom = useRef(room)
  currentRoom.current = room

  useEffect(() => {
    const messages = chatMessagesRef.current
    if (messages) messages.scrollTop = messages.scrollHeight
  }, [room.chat])

  useEffect(() => {
    fetch('/server/api/me', { credentials: 'include' }).then((r) => r.json()).then((d) => { setUser(d.user); setGoogleConfigured(d.googleConfigured) }).catch(() => setNotice('서버에 연결할 수 없습니다.'))
    const s = io({ path: '/server/socket.io', withCredentials: true, reconnection: true })
    socket.current = s
    s.on('connect', () => { setOnline(true); awaitingSync.current = true; s.emit('sync:request') })
    s.on('disconnect', () => setOnline(false))
    s.on('connect_error', (e: Error) => { setOnline(false); if (e.message) setNotice(e.message) })
    s.on('room:state', (next: Room) => {
      setRoom(next)
      if (awaitingSync.current) {
        awaitingSync.current = false
        window.setTimeout(() => {
          applyRoomToPlayer(player.current, playerReady.current, next, loadedVideo, pendingVideoSync)
        }, 500)
      }
    })
    s.on('chat:message', (m: Message) => setRoom((old) => ({ ...old, chat: [...old.chat.filter((x) => x.id !== m.id), m].slice(-100) })))
    s.on('room:announcement', (a: NonNullable<Room['announcement']>) => { setRoom((old) => ({ ...old, announcement: a })); setNotice('공지: ' + a.text) })
    s.on('playback:resynced', () => setNotice('재생 위치를 다시 동기화했어요.'))
    return () => { s.disconnect(); socket.current = null }
  }, [])

  useEffect(() => {
    if (!user?.admin) return
    const loadUsers = () => fetch('/server/api/admin/users', { credentials: 'include' }).then((r) => r.ok ? r.json() : null).then((data) => { if (data) setActiveUsers(data.activeUsers || []) }).catch(() => undefined)
    void loadUsers()
    const timer = window.setInterval(loadUsers, 10000)
    return () => window.clearInterval(timer)
  }, [user?.admin])

  useEffect(() => {
    const initializePlayer = () => {
      if (!window.YT?.Player || !playerHost.current || player.current) return

      player.current = new window.YT.Player(playerHost.current, {
        width: '100%',
        height: '100%',
        videoId: '',
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
          controls: 0,
          disablekb: 1,
          fs: 0,
        },
        events: {
          onReady: (event: { target: Player }) => {
            // The constructor's initial reference may not expose methods until ready.
            player.current = event.target
            playerReady.current = true
            event.target.setVolume?.(volume)
            applyRoomToPlayer(player.current, true, currentRoom.current, loadedVideo, pendingVideoSync)
          },
          onStateChange: (event: PlayerEvent) => {
            const states = window.YT?.PlayerState
            if (!states) return

            if (event.data === states.ENDED) {
              const endedTrack = currentRoom.current.current
              if (endedTrack) {
                socket.current?.emit('playback:ended', {
                  videoId: endedTrack.videoId,
                })
              }
            }

            // Track native YouTube pauses so resuming returns to the shared timeline.
            if (event.data === states.PAUSED && !currentRoom.current.paused && !localPausedRef.current) {
              manualPauseRef.current = true
            }
            if (event.data === states.PLAYING) {
              // Video loading can take time; seek again once playback actually starts.
              if (pendingVideoSync.current === currentRoom.current.current?.videoId) {
                event.target.seekTo?.(position(currentRoom.current), true)
                pendingVideoSync.current = null
                if (currentRoom.current.paused) event.target.pauseVideo?.()
              }
              if (currentRoom.current.paused) {
                event.target.seekTo?.(position(currentRoom.current), true)
                event.target.pauseVideo?.()
              } else if (manualPauseRef.current && !localPausedRef.current) {
                const expected = position(currentRoom.current)
                const actual = event.target.getCurrentTime?.()
                if (actual === undefined || !Number.isFinite(actual) || Math.abs(actual - expected) > 1.25) {
                  event.target.seekTo?.(expected, true)
                }
                manualPauseRef.current = false
              }
              setAutoplayBlocked(false)
            }
          },
          onAutoplayBlocked: () => {
            setAutoplayBlocked(true)
            setNotice('자동 재생이 차단됐어요. 아래 재생 버튼을 눌러주세요.')
          },
          onError: () => {
            setNotice('이 영상은 재생할 수 없습니다. 다른 영상을 추가해 주세요.')
          },
        },
      })
    }

    if (window.YT?.Player) {
      initializePlayer()
    } else {
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement('script')
        script.src = 'https://www.youtube.com/iframe_api'
        script.async = true
        document.head.appendChild(script)
      }

      const previousCallback = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        previousCallback?.()
        initializePlayer()
      }
    }

    return () => {
      playerReady.current = false
      player.current?.destroy?.()
      player.current = null
    }
  }, [])

  useEffect(() => {
    if (loadedVideo.current !== room.current?.videoId) {
      localPausedRef.current = false
      manualPauseRef.current = false
      setLocalPaused(false)
    }
    applyRoomToPlayer(player.current, playerReady.current, room, loadedVideo, pendingVideoSync)
    if (!room.paused && !localPausedRef.current && room.current) {
      player.current?.playVideo?.()
    }
  }, [room.current?.videoId, room.startedAt, room.paused, room.pausedAt])

  useEffect(() => {
    // Local pause is allowed. When the user resumes, the button seeks to the
    // shared timeline first; this timer never auto-resumes a locally paused player.
    const timer = window.setInterval(() => {
      const instance = player.current
      const current = currentRoom.current.current
      if (!instance || !playerReady.current || !current) return

      const states = window.YT?.PlayerState
      const playerState = instance.getPlayerState?.()
      if (currentRoom.current.paused) {
        if (playerState !== states?.PAUSED) instance.pauseVideo?.()
        return
      }
      if (localPausedRef.current) return
      if (playerState === states?.BUFFERING || playerState === states?.ENDED) return
      if (playerState !== states?.PLAYING) return

      if (instance.getPlaybackRate?.() !== 1) instance.setPlaybackRate?.(1)
      const actualPosition = instance.getCurrentTime?.()
      const expectedPosition = position(currentRoom.current)
      if (
        actualPosition !== undefined &&
        Number.isFinite(actualPosition) &&
        Math.abs(actualPosition - expectedPosition) > 2.5
      ) {
        instance.seekTo?.(expectedPosition, true)
      }
    }, 5000)

    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    player.current?.setVolume?.(volume)
    window.localStorage.setItem('mulay-volume', String(volume))
  }, [volume])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const instance = player.current
      if (!instance || !playerReady.current) return
      const time = instance.getCurrentTime?.()
      const duration = instance.getDuration?.()
      if (typeof time === 'number' && Number.isFinite(time)) setPlaybackTime(time)
      if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) setVideoDuration(duration)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  const search = async (event: FormEvent) => {
    event.preventDefault()
    const searchTerm = query.trim()
    if (!searchTerm) return

    setSearching(true)
    setSearchError('')
    setResults([])

    try {
      const response = await fetch(
        '/server/api/search?q=' + encodeURIComponent(searchTerm),
      )
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '검색에 실패했습니다.')

      setResults(data.items)
      if (!data.items.length) setSearchError('검색 결과가 없습니다.')
    } catch (error) {
      setSearchError(
        error instanceof Error ? error.message : '검색에 실패했습니다.',
      )
    } finally {
      setSearching(false)
    }
  }

  const add = (track: Result) => {
    if (track.durationSeconds > 600) {
      setNotice('10분을 초과하는 영상은 추가할 수 없어요.')
      return
    }
    if (!user) {
      setNotice('영상을 추가하려면 Google 로그인이 필요해요.')
      return
    }

    socket.current?.emit(
      'queue:add',
      track,
      (result: { ok: boolean; error?: string }) => {
        setNotice(
          result.ok ? '대기열에 추가했어요.' : result.error || '추가하지 못했어요.',
        )
        if (result.ok) {
          setResults((oldResults) =>
            oldResults.filter((item) => item.videoId !== track.videoId),
          )
        }
      },
    )
  }

  const vote = (track: Track, value: 1 | -1) => {
    if (!user) {
      setNotice('투표하려면 로그인이 필요해요.')
      return
    }

    socket.current?.emit(
      'queue:vote',
      { trackId: track.id, vote: value },
      (result: { ok: boolean; error?: string }) => {
        if (!result.ok) setNotice(result.error || '투표 실패')
      },
    )
  }

  const sendChat = (event: FormEvent) => {
    event.preventDefault()
    if (!chatInput.trim()) return

    socket.current?.emit(
      'chat:send',
      chatInput,
      (result: { ok: boolean; error?: string }) => {
        if (result.ok) setChatInput('')
        else setNotice(result.error || '채팅 실패')
      },
    )
  }

  const admin = (command: Record<string, string>) => {
    socket.current?.emit(
      'admin:command',
      command,
      (result: { ok: boolean; error?: string }) => {
        setNotice(
          result.ok ? '관리자 명령을 실행했어요.' : result.error || '명령 실패',
        )
      },
    )
  }

  const logout = async () => {
    await fetch('/server/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
    setUser(null)
    window.location.reload()
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark"></span>
          <span>mulay</span>
        </a>
        <div className="topbar-right">
          <span className={'connection ' + (online ? 'is-online' : '')}>
            <i />
            {online ? 'Online' : 'Offline'}
          </span>
          {user ? (
            <div className="user-chip">
              {user.avatar && <img src={user.avatar} alt="" />}
              <span>{user.name}</span>
              <button className="text-button" onClick={logout}>로그아웃</button>
            </div>
          ) : (
            <a
              className="login-button"
              href="/server/auth/google"
              title={!googleConfigured ? 'Google OAuth 설정 필요' : undefined}
            >
              <b>G</b> Google 로그인
            </a>
          )}
        </div>
      </header>

      <main>
        <section className="intro">
          <h1>누구나 듣는 음악</h1>
          <p>모두에게 자신만의 음악을 추천하세요!</p>
        </section>

        {room.announcement && (
          <div className="announcement">
            <span>공지</span>
            <p>{room.announcement.text}</p>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button onClick={() => setNotice('')} aria-label="알림 닫기">×</button>
          </div>
        )}

        <div className="watch-layout">
        <section className="player-card">
          <div className="player-frame">
            <div ref={playerHost} id="youtube-player" />
            <button
              className="fullscreen-button"
              type="button"
              aria-label="전체 화면"
              title="전체 화면"
              onClick={() => {
                const frame = document.querySelector('.watch-layout')
                if (!frame) return
                if (document.fullscreenElement) {
                  void document.exitFullscreen().catch(() => {
                    setNotice('전체 화면을 종료하지 못했어요.')
                  })
                  return
                }
                const request = frame.requestFullscreen;
                if (!request) {
                  setNotice('이 브라우저에서는 전체 화면을 지원하지 않아요.')
                  return
                }
                request.bind(frame)().catch(() => {
                  setNotice('전체 화면이 차단됐어요. 브라우저 권한을 확인해 주세요.')
                })
              }}
            >⛶</button>
            {room.current && autoplayBlocked && (
              <button
                className="player-start-overlay"
                onClick={() => player.current?.playVideo?.()}
              >
                ▶ 재생 시작
              </button>
            )}
            {!room.current && (
              <div className="player-empty">
                <span className="empty-icon">♫</span>
                <strong>아직 재생 중인 노래가 없어요</strong>
                <span>검색해서 첫 번째 곡을 추가해 보세요.</span>
              </div>
            )}
          </div>

          <div className="now-playing">
            <div className="now-label">
              <span className="equalizer"><i /><i /><i /></span>
              NOW PLAYING
            </div>
            <div className="track-title">{room.current?.title || '재생 대기 중'}</div>
            <div className="track-subtitle">
              {room.current?.channel || '함께 들을 노래를 기다리고 있어요'}
            </div>
            <div className="playback-meta">
              <span>{room.paused ? '전체 일시정지' : room.current ? '공동 재생 중' : '대기 중'}</span>
              <span>·</span>
              <span>{room.queue.length}곡 대기</span>
            </div>
            {room.current && (
              <>
                <div className="track-progress" aria-label="노래 재생 진행률">
                  <div className="track-progress-top">
                    <span>{formatTime(playbackTime)}</span>
                    <span>{formatTime(videoDuration)}</span>
                  </div>
                  <div className="track-progress-rail">
                    <div
                      className="track-progress-fill"
                      style={{ width: videoDuration > 0 ? Math.min(100, (playbackTime / videoDuration) * 100) + '%' : '0%' }}
                    />
                  </div>
                </div>
                <div className="track-added-by">
                  {room.current.addedByAvatar
                    ? <img src={room.current.addedByAvatar} alt="" />
                    : <span className="added-by-fallback">{(room.current.addedByName || '?').slice(0, 1).toUpperCase()}</span>}
                  <span><small>이 노래를 추가한 사람</small><strong>{room.current.addedByName || '알 수 없음'}</strong></span>
                </div>
              </>
            )}

            {room.current && (
              <div className="local-player-controls">
                <button
                  className="local-play-toggle"
                  type="button"
                  disabled={room.paused}
                  onClick={() => {
                    const instance = player.current
                    if (!instance) return
                    if (localPausedRef.current) {
                      instance.seekTo?.(position(currentRoom.current), true)
                      localPausedRef.current = false
                      setLocalPaused(false)
                      instance.playVideo?.()
                    } else {
                      localPausedRef.current = true
                      setLocalPaused(true)
                      instance.pauseVideo?.()
                    }
                  }}
                  aria-label={localPaused ? '재생' : '일시정지'}
                >
                  {localPaused ? '▶ 재생' : 'Ⅱ 일시정지'}
                </button>
                <label className="volume-control">
                  <span>볼륨</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={volume}
                    onChange={(event) => setVolume(Number(event.target.value))}
                    aria-label="볼륨 조절, 방향키로 5퍼센트씩 조절"
                    title="포커스 후 ← / → 방향키로 5%씩 조절"
                  />
                  <output>{volume}%</output>
                </label>
              </div>
            )}

            {room.current && (
              <div className="current-votes">
                <button onClick={() => vote(room.current!, 1)}>
                  ↑ 좋아요 {room.current.likes}
                </button>
                <button onClick={() => vote(room.current!, -1)}>
                  ↓ 싫어요 {room.current.dislikes}
                </button>
              </div>
            )}

            {user?.admin && (
              <div className="admin-playback">
                {room.current && (
                  <button onClick={() => admin({ action: room.paused ? 'resume' : 'pause' })}>
                    {room.paused ? '다시 재생' : '전체 일시정지'}
                  </button>
                )}
                <button onClick={() => admin({ action: 'skip' })}>다음 곡</button>
                <button onClick={() => admin({ action: 'stop' })}>재생 중단</button>
              </div>
            )}
          </div>
        </section>

        <section className="chat-section panel">
          <div className="section-heading">
            <div>
              <h2>채팅</h2>
            </div>
          </div>

          <div className="chat-messages" ref={chatMessagesRef}>
            {room.chat.map((message) => (
              <div
                className={[
                  'chat-message',
                  message.admin ? 'is-admin' : '',
                  message.senderSocketId && message.senderSocketId === socket.current?.id
                    ? 'is-own'
                    : '',
                ].filter(Boolean).join(' ')}
                key={message.id}
              >
                {message.avatar ? (
                  <img src={message.avatar} alt="" />
                ) : (
                  <span className="avatar-fallback">{message.name.slice(0, 1)}</span>
                )}
                <div className="chat-copy">
                  <div>
                    <strong>{message.name}</strong>
                    {message.admin && <span className="chat-role-badge">✦ ADMIN</span>}
                    {message.senderSocketId && message.senderSocketId === socket.current?.id && (
                      <span className="chat-own-badge">나</span>
                    )}
                    <time>
                      {new Date(message.at).toLocaleTimeString('ko-KR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  <p>{message.text}</p>
                </div>
              </div>
            ))}
          </div>

          <form className="chat-form" onSubmit={sendChat}>
            <input
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder={user ? '메시지를 입력하세요…' : '로그인 후 채팅할 수 있어요'}
              maxLength={500}
              disabled={!user}
            />
            <button
              type="submit"
              disabled={!user || !chatInput.trim()}
              aria-label="채팅 보내기"
            >
              ↗
            </button>
          </form>
        </section>
        </div>

        <section className="search-section">
          <div className="section-heading">
            <div>
              <span className="section-kicker">DISCOVER</span>
              <h2>어떤 노래를 들을까요?</h2>
            </div>
            <span className="muted small">YouTube에서 검색</span>
          </div>

          <form className="search-form" onSubmit={search}>
            <span className="search-icon">⌕</span>
            <input
              value={query}
              onChange={(event) => {
                const value = event.target.value
                setQuery(value)
                if (!value.trim()) {
                  setResults([])
                  setSearchError('')
                }
              }}
              placeholder="노래 제목, 아티스트 검색"
              maxLength={100}
            />
            {query && (
              <button
                className="search-clear-button"
                type="button"
                aria-label="검색어 지우기"
                title="검색어 지우기"
                onClick={() => {
                  setQuery('')
                  setResults([])
                  setSearchError('')
                }}
              >
                ×
              </button>
            )}
            <button type="submit" disabled={searching}>
              {searching ? '검색 중…' : '검색'}
            </button>
          </form>

          {searchError && <p className="inline-message">{searchError}</p>}
          {results.length > 0 && (
            <div className="search-results">
              {results.map((track) => (
                <article className="result-row" key={track.videoId}>
                  <img src={track.thumbnail} alt="" />
                  <div className="result-info">
                    <strong>{track.title}</strong>
                    <span>
                      {track.channel} · {Math.floor(track.durationSeconds / 60)}:
                      {String(track.durationSeconds % 60).padStart(2, '0')}
                    </span>
                  </div>
                  <button
                    className="add-button"
                    disabled={track.durationSeconds > 600}
                    onClick={() => add(track)}
                  >
                    {track.durationSeconds > 600 ? '10분 초과' : '＋ 추가'}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        <div className="lower-grid">
          <section className="queue-section panel">
            <div className="section-heading">
              <div>
                <h2>대기열 <span className="count">{room.queue.length}</span></h2>
              </div>
            </div>

            {!room.queue.length ? (
              <div className="empty-list">
                대기 중인 노래가 없어요.
                <br />
                첫 곡을 추천해 주세요.
              </div>
            ) : (
              <div className="queue-list">
                {room.queue.map((track, index) => (
                  <article className="queue-row" key={track.id}>
                    <span className="queue-index">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <img src={track.thumbnail} alt="" />
                    <div className="queue-info">
                      <strong>{track.title}</strong>
                      <span>{track.channel}</span>
                    </div>
                    <div className="vote-actions">
                      <button title="좋아요" onClick={() => vote(track, 1)}>
                        ↑ <span>{track.likes}</span>
                      </button>
                      <button title="싫어요" onClick={() => vote(track, -1)}>
                        ↓ <span>{track.dislikes}</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>


        </div>

        {user?.admin && (
          <section className="admin-panel panel">
            <div className="section-heading">
              <div>
                <h2>관리자 도구</h2>
              </div>
              <span className="admin-tag">ADMIN</span>
            </div>

            <div className="admin-tools">
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (adminId.trim()) admin({ action: 'ban', userId: adminId.trim() })
                }}
              >
                <label>사용자 ID 차단</label>
                <div className="admin-inline">
                  <select value={adminId} onChange={(event) => setAdminId(event.target.value)}>
                    <option value="">접속자 선택 ({activeUsers.length}명)</option>
                    {activeUsers.map((activeUser) => (
                      <option key={activeUser.id} value={activeUser.id}>
                        {activeUser.name} · {activeUser.id}
                      </option>
                    ))}
                  </select>
                  <input
                    value={adminId}
                    onChange={(event) => setAdminId(event.target.value)}
                    placeholder="또는 Google 사용자 ID 입력"
                  />
                  <button>차단</button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => admin({ action: 'unban', userId: adminId.trim() })}
                  >
                    차단 해제
                  </button>
                </div>
              </form>

              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  const text = new FormData(event.currentTarget)
                    .get('announcement')
                    ?.toString()
                    .trim()
                  if (text) {
                    admin({ action: 'announce', text })
                    event.currentTarget.reset()
                  }
                }}
              >
                <label>전체 공지</label>
                <div className="admin-inline">
                  <input
                    name="announcement"
                    maxLength={500}
                    placeholder="모든 접속자에게 보낼 공지"
                  />
                  <button>공지 보내기</button>
                </div>
              </form>
            </div>
          </section>
        )}

        <footer>
          <span>각 영상은 YouTube 공식 플레이어로 재생됩니다.</span>
        </footer>
      </main>
    </div>
  )
}
