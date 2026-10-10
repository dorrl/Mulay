import { randomUUID } from 'node:crypto'
import type { Server } from 'socket.io'
import { z } from 'zod'
import { WEB_ORIGIN } from '../config.js'
import { allowSocketEvent, connectedUsers } from '../runtime.js'
import { state, persist } from '../storage/room-store.js'
import type { ChatMessage } from '../types.js'
import { broadcastState, getUser, promoteNext, publicChatMessage, publicState, safeUser, toTrack } from '../services/room.js'
const videoIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{11}$/)
const addSchema = z.object({ videoId: videoIdSchema, title: z.string().min(1).max(200), channel: z.string().max(120), thumbnail: z.string().max(500).optional() })
const chatSchema = z.string().trim().min(1).max(500)
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ban'), userId: z.string().min(1).max(128) }),
  z.object({ action: z.literal('unban'), userId: z.string().min(1).max(128) }),
  z.object({ action: z.literal('announce'), text: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal('skip') }), z.object({ action: z.literal('stop') }),
])
export const registerSocketHandlers = (io: Server) => {
  io.use((socket, next) => {
    const origin = socket.handshake.headers.origin
    if (origin && origin !== WEB_ORIGIN) return next(new Error('origin not allowed'))
    const user = getUser(socket)
    if (!user) return next(new Error('로그인 필요'))
    if (state.bannedUsers.includes(user.id)) return next(new Error('이용이 제한된 계정'))
    next()
  })
  io.on('connection', socket => {
    const user = getUser(socket)!
    connectedUsers.set(socket.id, user)
    socket.on('disconnect', () => connectedUsers.delete(socket.id))
    socket.emit('room:state', publicState()); socket.emit('user:profile', safeUser(user))
    socket.on('sync:request', () => socket.emit('room:state', publicState()))
    socket.on('playback:ended', (raw: unknown) => {
      if (!allowSocketEvent(user.id, 'playback:ended', 2, 60000)) return
      const parsed = z.object({ videoId: videoIdSchema }).safeParse(raw)
      if (!parsed.success || state.current?.videoId !== parsed.data.videoId) return
      if (Date.now() - (state.startedAt ?? Date.now()) < 30000) return
      promoteNext(io)
    })
    socket.on('queue:add', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
      if (!allowSocketEvent(user.id, 'queue:add', 10, 60000)) return ack?.({ ok: false, error: '영상 추가 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' })
      const parsed = addSchema.safeParse(raw)
      if (!parsed.success) return ack?.({ ok: false, error: '영상 정보가 올바르지 않습니다.' })
      const now = Date.now()
      const lastAdded = state.history.filter(item => item.videoId === parsed.data.videoId).reduce((latest, item) => Math.max(latest, item.addedAt), 0)
      if (now - lastAdded < 6 * 60 * 60 * 1000) {
        const hours = Math.ceil((6 * 60 * 60 * 1000 - (now - lastAdded)) / 3600000)
        return ack?.({ ok: false, error: '같은 영상은 6시간마다 추가할 수 있습니다. 약 ' + hours + '시간 후 다시 시도하세요.' })
      }
      if (state.queue.length >= 100) return ack?.({ ok: false, error: '대기열이 가득 찼습니다.' })
      const track = toTrack(parsed.data.videoId, parsed.data.title, parsed.data.channel, parsed.data.thumbnail || '', user)
      state.history.push({ videoId: track.videoId, addedAt: now })
      state.history = state.history.filter(item => item.addedAt > now - 30 * 24 * 60 * 60 * 1000)
      if (!state.current) { state.current = track; state.startedAt = now; state.paused = false; state.pausedAt = null }
      else state.queue.push(track)
      await persist(); broadcastState(io); ack?.({ ok: true })
    })
    socket.on('queue:vote', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
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
      if (!allowSocketEvent(user.id, 'chat:send', 6, 10000)) return ack?.({ ok: false, error: '채팅을 너무 빠르게 보내고 있어요.' })
      const parsed = chatSchema.safeParse(raw)
      if (!parsed.success) return ack?.({ ok: false, error: '채팅은 1~500자로 입력하세요.' })
      const message: ChatMessage = { id: randomUUID(), userId: user.id, name: user.name, avatar: user.avatar, text: parsed.data, at: Date.now() }
      state.chat.push(message); state.chat = state.chat.slice(-200)
      await persist(); io.emit('chat:message', publicChatMessage(message)); ack?.({ ok: true })
    })
    socket.on('playback:ad-resync', async (raw: unknown) => {
      if (!allowSocketEvent(user.id, 'playback:ad-resync', 2, 60000)) return
      const parsed = z.object({ videoId: videoIdSchema, currentTime: z.number().finite().min(0).max(86400) }).safeParse(raw)
      if (!parsed.success || !state.current || state.current.videoId !== parsed.data.videoId) return
      const now = Date.now()
      if (now - (state.startedAt ?? 0) < 15000) return
      const expected = Math.max(0, (now - (state.startedAt ?? now)) / 1000)
      const drift = parsed.data.currentTime - expected
      if (Math.abs(drift) < 2 || Math.abs(drift) > 300) return
      state.startedAt = now - parsed.data.currentTime * 1000; state.paused = false; state.pausedAt = null
      await persist()
      io.emit('playback:resynced', { videoId: parsed.data.videoId, startedAt: state.startedAt, by: safeUser(user) })
      broadcastState(io)
    })
    socket.on('admin:command', async (raw: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => {
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
      else if (command.action === 'stop') {
        state.current = null; state.startedAt = null; state.pausedAt = null; state.paused = false
        await persist(); broadcastState(io)
      }
      await persist(); broadcastState(io); ack?.({ ok: true })
    })
  })
}
