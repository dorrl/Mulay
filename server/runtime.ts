import type { User } from './types.js'

export const connectedUsers = new Map<string, User>()
const socketEventTimes = new Map<string, number[]>()
let eventChecks = 0

export const allowSocketEvent = (userId: string, event: string, limit: number, windowMs: number) => {
  const key = userId + ':' + event
  const now = Date.now()

  // Anonymous clients can reconnect with a new socket ID indefinitely. Periodically
  // prune buckets older than the longest configured rate-limit window (60 seconds),
  // so this map cannot become an unbounded memory sink or weaken shorter/longer limits.
  if (++eventChecks % 256 === 0 || socketEventTimes.size > 5000) {
    for (const [bucketKey, times] of socketEventTimes) {
      const activeTimes = times.filter(time => now - time < 60_000)
      if (activeTimes.length) socketEventTimes.set(bucketKey, activeTimes)
      else socketEventTimes.delete(bucketKey)
    }
  }

  const recent = (socketEventTimes.get(key) || []).filter(time => now - time < windowMs)
  if (recent.length >= limit) {
    socketEventTimes.set(key, recent)
    return false
  }
  recent.push(now)
  socketEventTimes.set(key, recent)
  return true
}
