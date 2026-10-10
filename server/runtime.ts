import type { User } from './types.js'
export const connectedUsers = new Map<string, User>()
const socketEventTimes = new Map<string, number[]>()
export const allowSocketEvent = (userId: string, event: string, limit: number, windowMs: number) => {
  const key = userId + ':' + event
  const now = Date.now()
  const recent = (socketEventTimes.get(key) || []).filter((time) => now - time < windowMs)
  if (recent.length >= limit) { socketEventTimes.set(key, recent); return false }
  recent.push(now); socketEventTimes.set(key, recent); return true
}
