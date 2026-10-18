import { randomUUID } from 'node:crypto'
import type { Socket, Server } from 'socket.io'
import { state, persist } from '../storage/room-store.js'
import type { ChatMessage, Track, User } from '../types.js'
export const safeUser = (u: User) => ({ id: u.id, name: u.name, avatar: u.avatar, admin: u.admin })
export const toTrack = (videoId: string, title: string, channel: string, thumbnail: string, user: User, durationSeconds?: number): Track => ({
  id: randomUUID(), videoId, title: title.slice(0, 200), channel: channel.slice(0, 120),
  thumbnail: thumbnail.startsWith('https://i.ytimg.com/') ? thumbnail : 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg',
  durationSeconds,
  addedBy: user.id, addedByName: user.name, addedByAvatar: user.avatar, addedAt: Date.now(), votes: {},
})
export const publicState = () => ({
  current: state.current ? (({ votes, ...track }) => ({ ...track, likes: Object.values(votes).filter(v => v === 1).length, dislikes: Object.values(votes).filter(v => v === -1).length }))(state.current) : null,
  queue: state.queue.map(({ votes, ...track }) => ({ ...track, likes: Object.values(votes).filter(v => v === 1).length, dislikes: Object.values(votes).filter(v => v === -1).length })),
  startedAt: state.startedAt, pausedAt: state.pausedAt, paused: state.paused, announcement: state.announcement,
  chat: state.chat.slice(-100).map(({ userId: _userId, ...message }) => message),
  recommendationCooldownMinutes: state.recommendationCooldownMinutes ?? 5,
})
export const broadcastState = (io: Server) => {
  io.emit('room:state', publicState())
  for (const socket of io.sockets.sockets.values()) {
    const user = getUser(socket)
    if (!user) continue
    const votes: Record<string, 1 | -1> = {}
    for (const track of [...(state.current ? [state.current] : []), ...state.queue]) {
      const vote = track.votes[user.id]
      if (vote === 1 || vote === -1) votes[track.id] = vote
    }
    socket.emit('queue:my-votes', votes)
  }
}
export const promoteNext = (io: Server) => {
  state.current = state.queue.shift() ?? null; state.startedAt = state.current ? Date.now() : null
  state.pausedAt = null; state.paused = false; void persist(); broadcastState(io)
}

// Server-side fallback: advance tracks from the authoritative start time and duration,
// even when no browser is connected to report YouTube's ENDED event.
export const checkPlaybackEnd = (io: Server) => {
  const track = state.current
  if (!track || state.paused || state.startedAt === null) return
  if (!Number.isFinite(track.durationSeconds) || (track.durationSeconds ?? 0) <= 0) return
  const elapsedSeconds = (Date.now() - state.startedAt) / 1000
  if (elapsedSeconds >= (track.durationSeconds as number) + 2) promoteNext(io)
}
export const getUser = (socket: Socket): User | null => (socket.request as typeof socket.request & { user?: User }).user ?? null
export const publicChatMessage = (message: ChatMessage, senderSocketId?: string) => {
  const { userId: _userId, ...publicMessage } = message
  return { ...publicMessage, ...(senderSocketId ? { senderSocketId } : {}) }
}
