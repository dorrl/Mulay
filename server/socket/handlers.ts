import { randomUUID } from 'node:crypto'
import type { Server } from 'socket.io'
import { z } from 'zod'
import { WEB_ORIGIN } from '../config.js'
import { allowSocketEvent, connectedUsers } from '../runtime.js'
import { state, persist } from '../storage/room-store.js'
import type { ChatMessage } from '../types.js'
import { broadcastState, getUser, promoteNext, publicChatMessage, publicState, safeUser, toTrack } from '../services/room.js'
import { fetchVideoDurations } from '../services/youtube.js'
const videoIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{11}$/)
const addSchema = z.object({ videoId: videoIdSchema, title: z.string().min(1).max(200), channel: z.string().max(120), thumbnail: z.string().max(500).optional(), allowLongDuration: z.boolean().optional() })
const chatSchema = z.string().trim().min(1).max(500)
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ban'), userId: z.string().min(1).max(128) }),
  z.object({ action: z.literal('unban'), userId: z.string().min(1).max(128) }),
  z.object({ action: z.literal('announce'), text: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal('skip') }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('setRecommendationCooldown'), minutes: z.number().int().min(0).max(1440) }),
])
export const registerSocketHandlers = (io: Server) => {
  io.use((socket, next) => {
    const origin = socket.handshake.headers.origin
    // Browsers normally send Origin. In production, reject missing Origin as well
    // as mismatches so non-browser clients cannot bypass the origin gate.
    if (process.env.NODE_ENV === 'production' ? origin !== WEB_ORIGIN : Boolean(origin && origin !== WEB_ORIGIN)) {
      return next(new Error('origin not allowed'))
    }
    const user = getUser(socket)
    if (user && state.bannedUsers.includes(user.id)) return next(new Error('이용이 제한된 계정'))
    next()
  })
  io.on('connection', socket => {
    const user = getUser(socket)
    const actorId = user?.id ?? `guest:${socket.id}`
    if (user) connectedUsers.set(socket.id, user)
    socket.on('disconnect', () => connectedUsers.delete(socket.id))
    socket.emit('room:state', publicState())
    const emitMyVotes = () => {
      if (!user) return
      const votes: Record<string, 1 | -1> = {}
      for (const track of [...(state.current ? [state.current] : []), ...state.queue]) {
        const vote = track.votes[user.id]
        if (vote === 1 || vote === -1) votes[track.id] = vote
      }
      socket.emit('queue:my-votes', votes)
    }
    emitMyVotes()
    if (user) socket.emit('user:profile', safeUser(user))
    socket.on('sync:request', () => { socket.emit('room:state', publicState()); emitMyVotes() })
    socket.on('playback:ended', (raw: unknown) => {
      if (!allowSocketEvent(actorId, 'playback:ended', 2, 60000)) return
      const parsed = z.object({ videoId: videoIdSchema }).safeParse(raw)
      if (!parsed.success || state.current?.videoId !== parsed.data.videoId) return
      if (Date.now() - (state.startedAt ?? Date.now()) < 30000) return
      promoteNext(io)
    })
    socket.on('queue:add', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
      if (!user) return ack?.({ ok: false, error: '영상을 추가하려면 로그인이 필요합니다.' })
      if (!allowSocketEvent(user.id, 'queue:add', 10, 60000)) return ack?.({ ok: false, error: '영상 추가 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' })
      const parsed = addSchema.safeParse(raw)
      if (!parsed.success) return ack?.({ ok: false, error: '영상 정보가 올바르지 않습니다.' })
      const now = Date.now()
      const lastUserAdded = state.history.filter(item => item.addedBy === user.id).reduce((latest, item) => Math.max(latest, item.addedAt), 0)
      const cooldownMs = (state.recommendationCooldownMinutes ?? 5) * 60 * 1000
      const cooldownRemaining = cooldownMs - (now - lastUserAdded)
      if (!user.admin && cooldownMs > 0 && cooldownRemaining > 0) {
        return ack?.({
          ok: false,
          error: `영상 추가 쿨타임이 남았습니다. ${Math.ceil(cooldownRemaining / 60000)}분 후 다시 시도하세요.`,
        })
      }
      const lastAdded = state.history.filter(item => item.videoId === parsed.data.videoId).reduce((latest, item) => Math.max(latest, item.addedAt), 0)
      if (!user.admin && now - lastAdded < 6 * 60 * 60 * 1000) {
        const hours = Math.ceil((6 * 60 * 60 * 1000 - (now - lastAdded)) / 3600000)
        return ack?.({ ok: false, error: '같은 영상은 6시간마다 추가할 수 있습니다. 약 ' + hours + '시간 후 다시 시도하세요.' })
      }
      if (state.queue.length >= 100) return ack?.({ ok: false, error: '대기열이 가득 찼습니다.' })
      let durationSeconds: number | undefined
      try { const durations = await fetchVideoDurations([parsed.data.videoId]); durationSeconds = durations.get(parsed.data.videoId) }
      catch { return ack?.({ ok: false, error: '영상 길이를 확인하지 못했습니다. 잠시 후 다시 시도하세요.' }) }
      if (durationSeconds === undefined) return ack?.({ ok: false, error: '영상 길이를 확인할 수 없습니다.' })
      if (durationSeconds > 600 && !(user.admin && parsed.data.allowLongDuration === true)) return ack?.({ ok: false, error: '10분을 초과하는 영상은 관리자만 확인 후 추가할 수 있습니다.' })
      const checkedAt = Date.now()
      const recentUserAdd = state.history.reduce((latest, item) => item.addedBy === user.id ? Math.max(latest, item.addedAt) : latest, 0)
      if (!user.admin && (state.recommendationCooldownMinutes ?? 5) > 0 && checkedAt - recentUserAdd < (state.recommendationCooldownMinutes ?? 5) * 60 * 1000) {
        const remaining = 5 * 60 * 1000 - (checkedAt - recentUserAdd)
        return ack?.({
          ok: false,
          error: `영상 추가 쿨타임이 남았습니다. ${Math.ceil(remaining / 60000)}분 후 다시 시도하세요.`,
        })
      }
      const recentSameVideo = state.history.reduce((latest, item) => item.videoId === parsed.data.videoId ? Math.max(latest, item.addedAt) : latest, 0)
      if (!user.admin && checkedAt - recentSameVideo < 6 * 60 * 60 * 1000) {
        const hours = Math.ceil((6 * 60 * 60 * 1000 - (checkedAt - recentSameVideo)) / 3600000)
        return ack?.({
          ok: false,
          error: '같은 영상은 6시간마다 추가할 수 있습니다. 약 ' + hours + '시간 후 다시 시도하세요.',
        })
      }
      const track = toTrack(parsed.data.videoId, parsed.data.title, parsed.data.channel, parsed.data.thumbnail || '', user, durationSeconds)
      state.history.push({ videoId: track.videoId, addedAt: checkedAt, addedBy: user.id })
      state.history = state.history.filter(item => item.addedAt > now - 30 * 24 * 60 * 60 * 1000)
      if (!state.current) { state.current = track; state.startedAt = now; state.paused = false; state.pausedAt = null }
      else state.queue.push(track)
      await persist(); broadcastState(io); ack?.({ ok: true })
    })
    socket.on('queue:vote', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
      if (!user) return ack?.({ ok: false, error: '투표하려면 로그인이 필요합니다.' })
      if (!allowSocketEvent(user.id, 'queue:vote', 60, 60000)) return ack?.({ ok: false, error: '투표 요청이 너무 많습니다.' })
      const parsed = z.object({ trackId: z.string().uuid(), vote: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).safeParse(raw)
      if (!parsed.success) return ack?.({ ok: false, error: '투표 값이 올바르지 않습니다.' })
      const track = state.queue.find(item => item.id === parsed.data.trackId) || (state.current?.id === parsed.data.trackId ? state.current : null)
      if (!track) return ack?.({ ok: false, error: '영상을 찾을 수 없습니다.' })
      if (parsed.data.vote === 0) delete track.votes[user.id]
      else track.votes[user.id] = parsed.data.vote
      await persist(); broadcastState(io); ack?.({ ok: true })
    })
    socket.on('chat:send', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
      if (!user) return ack?.({ ok: false, error: '채팅하려면 로그인이 필요합니다.' })
      if (!allowSocketEvent(user.id, 'chat:send', 6, 10000)) return ack?.({ ok: false, error: '채팅을 너무 빠르게 보내고 있어요.' })
      const parsed = chatSchema.safeParse(raw)
      if (!parsed.success) return ack?.({ ok: false, error: '채팅은 1~500자로 입력하세요.' })
      const message: ChatMessage = { id: randomUUID(), userId: user.id, name: user.name, avatar: user.avatar, text: parsed.data, at: Date.now(), admin: user.admin }
      state.chat.push(message); state.chat = state.chat.slice(-200)
      await persist(); io.emit('chat:message', publicChatMessage(message, socket.id)); ack?.({ ok: true })
    })
    socket.on('admin:command', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
      if (!user) return ack?.({ ok: false, error: '관리자 권한이 필요합니다.' })
      if (!allowSocketEvent(user.id, 'admin:command', 20, 60000)) return ack?.({ ok: false, error: '관리자 명령 요청이 너무 많습니다.' })
      if (!user.admin) return ack?.({ ok: false, error: '관리자 권한이 필요합니다.' })
      const parsed = commandSchema.safeParse(raw)
      if (!parsed.success) return ack?.({ ok: false, error: '관리자 명령이 올바르지 않습니다.' })
      const command = parsed.data
      if (command.action === 'ban') {
        if (!state.bannedUsers.includes(command.userId)) state.bannedUsers.push(command.userId)
        for (const client of io.sockets.sockets.values()) if (getUser(client)?.id === command.userId) client.disconnect(true)
      } else if (command.action === 'unban') state.bannedUsers = state.bannedUsers.filter(id => id !== command.userId)
      else if (command.action === 'announce') { state.announcement = { id: randomUUID(), text: command.text, at: Date.now() }; io.emit('room:announcement', state.announcement) }
      else if (command.action === 'skip') promoteNext(io)
      else if (command.action === 'pause') {
        if (state.current && !state.paused && state.startedAt !== null) {
          state.pausedAt = Math.max(0, (Date.now() - state.startedAt) / 1000)
          state.paused = true
        }
      } else if (command.action === 'resume') {
        if (state.current && state.paused && state.pausedAt !== null) {
          state.startedAt = Date.now() - state.pausedAt * 1000
          state.pausedAt = null
          state.paused = false
        }
      } else if (command.action === 'setRecommendationCooldown') {
        state.recommendationCooldownMinutes = command.minutes
      } else if (command.action === 'stop') {
        state.current = null; state.startedAt = null; state.pausedAt = null; state.paused = false
      }
      await persist(); broadcastState(io); ack?.({ ok: true })
    })
  })
}
