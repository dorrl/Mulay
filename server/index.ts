import 'dotenv/config'
import express from 'express'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import session from 'express-session'
import passport from 'passport'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { Server } from 'socket.io'
import { z } from 'zod'

const PORT = Number(process.env.PORT || 3001)
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5173'
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data')
const DATA_FILE = path.join(DATA_DIR, 'room.json')
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json')
const SESSION_SECRET = process.env.SESSION_SECRET
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be at least 32 characters in production.')
  console.warn('[security] Set SESSION_SECRET to a random value of at least 32 characters.')
}
type StoredSession = { expiresAt: number; data: session.SessionData }

class JsonSessionStore extends session.Store {
  private sessions: Record<string, StoredSession> = {}
  private readonly loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor() {
    super()
    this.loaded = this.load()
  }

  private async load() {
    await mkdir(DATA_DIR, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(SESSION_FILE, 'utf8')) as Record<string, StoredSession>
      const now = Date.now()
      this.sessions = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value && value.expiresAt > now && value.data))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[storage] Could not read session JSON:', error)
      }
      this.sessions = {}
    }
    await this.persist()
  }

  private persist() {
    const snapshot = JSON.stringify(this.sessions, null, 2)
    this.writes = this.writes.then(async () => {
      await mkdir(DATA_DIR, { recursive: true })
      const tempFile = SESSION_FILE + '.tmp'
      await writeFile(tempFile, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(tempFile, SESSION_FILE)
    })
    return this.writes
  }

  get(sid: string, callback: (err: any, session?: session.SessionData | null) => void) {
    void this.loaded.then(async () => {
      const record = this.sessions[sid]
      if (record && record.expiresAt <= Date.now()) {
        delete this.sessions[sid]
        await this.persist()
      }
      callback(null, record && record.expiresAt > Date.now() ? record.data : null)
    }).catch(callback)
  }

  set(sid: string, value: session.SessionData, callback?: (err?: any) => void) {
    void this.loaded.then(() => {
      const expiresAt = value.cookie.expires?.getTime() ?? Date.now() + (value.cookie.maxAge ?? 7 * 24 * 60 * 60 * 1000)
      this.sessions[sid] = { expiresAt, data: value }
      return this.persist()
    }).then(() => callback?.(null)).catch((error) => callback?.(error))
  }

  destroy(sid: string, callback?: (err?: any) => void) {
    void this.loaded.then(() => {
      delete this.sessions[sid]
      return this.persist()
    }).then(() => callback?.(null)).catch((error) => callback?.(error))
  }

  touch(sid: string, value: session.SessionData, callback?: () => void) {
    void this.loaded.then(() => {
      const record = this.sessions[sid]
      if (!record) return
      record.data = value
      record.expiresAt = value.cookie.expires?.getTime() ?? Date.now() + (value.cookie.maxAge ?? 7 * 24 * 60 * 60 * 1000)
      return this.persist()
    }).then(() => callback?.()).catch((error) => console.error('[storage] Could not update session:', error))
  }
}

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: WEB_ORIGIN, credentials: true },
  maxHttpBufferSize: 1e6,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
})

type User = { id: string; name: string; email: string; avatar: string; admin: boolean }
const connectedUsers = new Map<string, User>()
const socketEventTimes = new Map<string, number[]>()
const allowSocketEvent = (userId: string, event: string, limit: number, windowMs: number) => {
  const key = userId + ':' + event
  const now = Date.now()
  const recent = (socketEventTimes.get(key) || []).filter((time) => now - time < windowMs)
  if (recent.length >= limit) { socketEventTimes.set(key, recent); return false }
  recent.push(now)
  socketEventTimes.set(key, recent)
  return true
}
type Track = { id: string; videoId: string; title: string; channel: string; thumbnail: string; addedBy: string; addedAt: number; votes: Record<string, 1 | -1> }
type ChatMessage = { id: string; userId: string; name: string; avatar: string; text: string; at: number }
type RoomState = {
  current: Track | null
  queue: Track[]
  history: { videoId: string; addedAt: number }[]
  startedAt: number | null
  pausedAt: number | null
  paused: boolean
  announcement: { id: string; text: string; at: number } | null
  bannedUsers: string[]
  chat: ChatMessage[]
}
const blankState = (): RoomState => ({ current: null, queue: [], history: [], startedAt: null, pausedAt: null, paused: false, announcement: null, bannedUsers: [], chat: [] })
let state: RoomState = blankState()
let writeChain = Promise.resolve()
const persist = () => {
  const snapshot = JSON.stringify(state, null, 2)
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true })
    const temp = DATA_FILE + '.tmp'
    await writeFile(temp, snapshot, { mode: 0o600 })
    await rename(temp, DATA_FILE)
  }).catch((error) => console.error('[storage] Could not persist room state:', error))
  return writeChain
}
const loadState = async () => {
  await mkdir(DATA_DIR, { recursive: true })
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, 'utf8')) as Partial<RoomState>
    state = { ...blankState(), ...parsed, queue: parsed.queue ?? [], history: parsed.history ?? [], bannedUsers: parsed.bannedUsers ?? [], chat: parsed.chat ?? [] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[storage] Invalid room data; starting with an empty room.', error)
    await persist()
  }
}
const safeUser = (u: User) => ({ id: u.id, name: u.name, avatar: u.avatar, admin: u.admin })
const admins = new Set((process.env.ADMIN_GOOGLE_IDS || '').split(',').map((v) => v.trim()).filter(Boolean))
const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean))
const toTrack = (videoId: string, title: string, channel: string, thumbnail: string, user: User): Track => ({
  id: randomUUID(), videoId, title: title.slice(0, 200), channel: channel.slice(0, 120),
  thumbnail: thumbnail.startsWith('https://i.ytimg.com/') ? thumbnail : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  addedBy: user.id, addedAt: Date.now(), votes: {},
})
const publicState = () => ({
  current: state.current ? (({ votes, ...track }) => ({ ...track, likes: Object.values(votes).filter((v) => v === 1).length, dislikes: Object.values(votes).filter((v) => v === -1).length }))(state.current) : null,
  queue: state.queue.map(({ votes, ...track }) => ({ ...track, likes: Object.values(votes).filter((v) => v === 1).length, dislikes: Object.values(votes).filter((v) => v === -1).length })),
  startedAt: state.startedAt, pausedAt: state.pausedAt, paused: state.paused,
  announcement: state.announcement, chat: state.chat.slice(-100).map(({ userId: _userId, ...message }) => message),
})
const broadcastState = () => io.emit('room:state', publicState())
const promoteNext = () => {
  state.current = state.queue.shift() ?? null
  state.startedAt = state.current ? Date.now() : null
  state.pausedAt = null
  state.paused = false
  void persist()
  broadcastState()
}
const getUser = (socket: import('socket.io').Socket): User | null => (socket.request as typeof socket.request & { user?: User }).user ?? null

app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false)
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.youtube.com', 'https://s.ytimg.com', 'https://apis.google.com'], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'data:', 'https://i.ytimg.com', 'https://*.googleusercontent.com', 'https://*.ggpht.com'], frameSrc: ["'self'", 'https://www.youtube.com', 'https://youtube.com', 'https://accounts.google.com'], connectSrc: ["'self'", 'https://www.googleapis.com', 'https://www.youtube.com', 'wss:', 'ws:'] } } }))
app.use(express.json({ limit: '32kb' }))
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }))
const sessionMiddleware = session({
  name: 'mulay.sid',
  secret: SESSION_SECRET || 'development-only-secret-change-before-deploy',
  resave: false,
  saveUninitialized: false,
  store: new JsonSessionStore(),
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 },
})
app.use(sessionMiddleware)
app.use(passport.initialize())
app.use(passport.session())
io.engine.use(sessionMiddleware as never)
io.engine.use(passport.initialize() as never)
io.engine.use(passport.session() as never)

passport.serializeUser((user, done) => done(null, user))
passport.deserializeUser((user: Express.User, done) => done(null, user))
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/auth/google/callback',
    scope: ['profile', 'email'],
    state: true,
  }, (_accessToken, _refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || ''
    const emailVerified = profile._json.email_verified === true
    const user: User = {
      id: profile.id,
      name: (profile.displayName || 'Listener').slice(0, 80),
      email: email.slice(0, 254),
      avatar: profile.photos?.[0]?.value || '',
      admin: admins.has(profile.id) || (emailVerified && adminEmails.has(email.toLowerCase())),
    }
    done(null, user)
  }))
}
const requireUser = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const user = req.user as User | undefined
  if (!user) return res.status(401).json({ error: 'Google 로그인이 필요합니다.' })
  if (state.bannedUsers.includes(user.id)) return res.status(403).json({ error: '이 계정은 이용이 제한되었습니다.' })
  next()
}
const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!(req.user as User | undefined)?.admin) return res.status(403).json({ error: '관리자 권한이 필요합니다.' })
  next()
}
app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.get('/api/me', (req, res) => {
  const user = req.user as User | undefined
  res.json({ user: user && !state.bannedUsers.includes(user.id) ? safeUser(user) : null, googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) })
})
app.get('/api/room', (_req, res) => res.json(publicState()))
app.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(503).send('Google OAuth가 설정되지 않았습니다. .env 파일을 확인하세요.')
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })(req, res, next)
})
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/?login=failed' }), (_req, res) => res.redirect(WEB_ORIGIN))
app.post('/auth/logout', (req, res, next) => req.logout((error) => {
  if (error) return next(error)
  req.session.destroy((destroyError) => {
    if (destroyError) return next(destroyError)
    res.clearCookie('mulay.sid')
    res.json({ ok: true })
  })
}))
app.get('/api/search', async (req, res) => {
  const query = z.string().trim().min(1).max(100).safeParse(req.query.q)
  if (!query.success) return res.status(400).json({ error: '검색어를 1~100자로 입력하세요.' })
  if (!process.env.YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube Data API 키가 설정되지 않았습니다.' })
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search')
    url.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '8', q: query.data, key: process.env.YOUTUBE_API_KEY, videoEmbeddable: 'true', safeSearch: 'moderate' }).toString()
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return res.status(502).json({ error: 'YouTube 검색에 실패했습니다.' })
    const body = await response.json() as { items?: { id: { videoId?: string }; snippet: { title: string; channelTitle: string; thumbnails?: { medium?: { url?: string }; high?: { url?: string } } } }[] }
    const items = (body.items ?? []).filter((item) => item.id.videoId).map((item) => ({
      videoId: item.id.videoId!, title: item.snippet.title, channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.high?.url || '',
    }))
    res.json({ items })
  } catch {
    res.status(502).json({ error: 'YouTube 검색 서버에 연결할 수 없습니다.' })
  }
})
app.get('/api/admin/users', requireUser, requireAdmin, (_req, res) => {
  const activeUsers = Array.from(new Map(Array.from(connectedUsers.values()).map((u) => [u.id, safeUser(u)])).values())
  res.json({ bannedUsers: state.bannedUsers, activeUsers })
})

const videoIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{11}$/)
const addSchema = z.object({ videoId: videoIdSchema, title: z.string().min(1).max(200), channel: z.string().max(120), thumbnail: z.string().max(500).optional() })
const chatSchema = z.string().trim().min(1).max(500)
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ban'), userId: z.string().min(1).max(128) }),
  z.object({ action: z.literal('unban'), userId: z.string().min(1).max(128) }),
  z.object({ action: z.literal('announce'), text: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal('skip') }),
  z.object({ action: z.literal('stop') }),
])
io.use((socket, next) => {
  const origin = socket.handshake.headers.origin
  if (origin && origin !== WEB_ORIGIN) return next(new Error('origin not allowed'))
  const user = getUser(socket)
  if (!user) return next(new Error('로그인 필요'))
  if (state.bannedUsers.includes(user.id)) return next(new Error('이용이 제한된 계정'))
  next()
})
io.on('connection', (socket) => {
  const user = getUser(socket)!
  connectedUsers.set(socket.id, user)
  socket.on('disconnect', () => connectedUsers.delete(socket.id))
  socket.emit('room:state', publicState())
  socket.emit('user:profile', safeUser(user))
  socket.on('sync:request', () => socket.emit('room:state', publicState()))
  socket.on('playback:ended', (raw: unknown) => {
    if (!allowSocketEvent(user.id, 'playback:ended', 2, 60_000)) return
    const parsed = z.object({ videoId: videoIdSchema }).safeParse(raw)
    if (!parsed.success || state.current?.videoId !== parsed.data.videoId) return
    if (Date.now() - (state.startedAt ?? Date.now()) < 30_000) return
    promoteNext()
  })

  socket.on('queue:add', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
    if (!allowSocketEvent(user.id, 'queue:add', 10, 60_000)) return ack?.({ ok: false, error: '영상 추가 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' })
    const parsed = addSchema.safeParse(raw)
    if (!parsed.success) return ack?.({ ok: false, error: '영상 정보가 올바르지 않습니다.' })
    const now = Date.now()
    const lastAdded = state.history.filter((item) => item.videoId === parsed.data.videoId).reduce((latest, item) => Math.max(latest, item.addedAt), 0)
    if (now - lastAdded < 6 * 60 * 60 * 1000) {
      const hours = Math.ceil((6 * 60 * 60 * 1000 - (now - lastAdded)) / 3_600_000)
      return ack?.({ ok: false, error: `같은 영상은 6시간마다 추가할 수 있습니다. 약 ${hours}시간 후 다시 시도하세요.` })
    }
    if (state.queue.length >= 100) return ack?.({ ok: false, error: '대기열이 가득 찼습니다.' })
    const track = toTrack(parsed.data.videoId, parsed.data.title, parsed.data.channel, parsed.data.thumbnail || '', user)
    state.history.push({ videoId: track.videoId, addedAt: now })
    state.history = state.history.filter((item) => item.addedAt > now - 30 * 24 * 60 * 60 * 1000)
    if (!state.current) {
      state.current = track
      state.startedAt = now
      state.paused = false
      state.pausedAt = null
    } else state.queue.push(track)
    await persist()
    broadcastState()
    ack?.({ ok: true })
  })
  socket.on('queue:vote', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
    if (!allowSocketEvent(user.id, 'queue:vote', 60, 60_000)) return ack?.({ ok: false, error: '투표 요청이 너무 많습니다.' })
    const schema = z.object({ trackId: z.string().uuid(), vote: z.union([z.literal(1), z.literal(-1), z.literal(0)]) })
    const parsed = schema.safeParse(raw)
    if (!parsed.success) return ack?.({ ok: false, error: '투표 값이 올바르지 않습니다.' })
    const track = state.queue.find((item) => item.id === parsed.data.trackId) || (state.current?.id === parsed.data.trackId ? state.current : null)
    if (!track) return ack?.({ ok: false, error: '영상을 찾을 수 없습니다.' })
    if (parsed.data.vote === 0) delete track.votes[user.id]
    else track.votes[user.id] = parsed.data.vote
    await persist()
    broadcastState()
    ack?.({ ok: true })
  })
  socket.on('chat:send', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
    if (!allowSocketEvent(user.id, 'chat:send', 6, 10_000)) return ack?.({ ok: false, error: '채팅을 너무 빠르게 보내고 있어요.' })
    const parsed = chatSchema.safeParse(raw)
    if (!parsed.success) return ack?.({ ok: false, error: '채팅은 1~500자로 입력하세요.' })
    const message: ChatMessage = { id: randomUUID(), userId: user.id, name: user.name, avatar: user.avatar, text: parsed.data, at: Date.now() }
    state.chat.push(message)
    state.chat = state.chat.slice(-200)
    await persist()
    io.emit('chat:message', (({ userId: _userId, ...publicMessage }) => publicMessage)(message))
    ack?.({ ok: true })
  })
  socket.on('playback:ad-resync', async (raw: unknown) => {
    if (!allowSocketEvent(user.id, 'playback:ad-resync', 2, 60_000)) return
    const parsed = z.object({ videoId: videoIdSchema, currentTime: z.number().finite().min(0).max(86400) }).safeParse(raw)
    if (!parsed.success || !state.current || state.current.videoId !== parsed.data.videoId) return
    const now = Date.now()
    if (now - (state.startedAt ?? 0) < 15_000) return
    const expected = Math.max(0, (now - (state.startedAt ?? now)) / 1000)
    const drift = parsed.data.currentTime - expected
    if (Math.abs(drift) < 2 || Math.abs(drift) > 300) return
    state.startedAt = now - parsed.data.currentTime * 1000
    state.paused = false
    state.pausedAt = null
    await persist()
    io.emit('playback:resynced', { videoId: parsed.data.videoId, startedAt: state.startedAt, by: safeUser(user) })
    broadcastState()
  })
  socket.on('admin:command', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
    if (!allowSocketEvent(user.id, 'admin:command', 20, 60_000)) return ack?.({ ok: false, error: '관리자 명령 요청이 너무 많습니다.' })
    if (!user.admin) return ack?.({ ok: false, error: '관리자 권한이 필요합니다.' })
    const parsed = commandSchema.safeParse(raw)
    if (!parsed.success) return ack?.({ ok: false, error: '관리자 명령이 올바르지 않습니다.' })
    const command = parsed.data
    if (command.action === 'ban') {
      if (!state.bannedUsers.includes(command.userId)) state.bannedUsers.push(command.userId)
      for (const client of io.sockets.sockets.values()) if (getUser(client)?.id === command.userId) client.disconnect(true)
    } else if (command.action === 'unban') {
      state.bannedUsers = state.bannedUsers.filter((id) => id !== command.userId)
    } else if (command.action === 'announce') {
      state.announcement = { id: randomUUID(), text: command.text, at: Date.now() }
      io.emit('room:announcement', state.announcement)
    } else if (command.action === 'skip') {
      promoteNext()
    } else if (command.action === 'stop') {
      state.current = null
      state.startedAt = null
      state.pausedAt = null
      state.paused = false
      await persist()
      broadcastState()
    }
    await persist()
    broadcastState()
    ack?.({ ok: true })
  })
})

if (existsSync(path.resolve('./dist'))) {
  const dist = path.resolve('./dist')
  app.use(express.static(dist, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }))
  app.use((req, res, next) => { if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/socket.io/')) return next(); res.sendFile(path.join(dist, 'index.html')) })
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[http]', error)
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' })
})

await loadState()
httpServer.listen(PORT, () => console.log(`Mulay server listening on :${PORT}`))
