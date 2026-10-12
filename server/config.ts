import 'dotenv/config'
import path from 'node:path'
export const PORT = 33541
export const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:33541'
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data')
export const DATA_FILE = path.join(DATA_DIR, 'room.json')
export const SESSION_FILE = path.join(DATA_DIR, 'sessions.json')
export const SESSION_SECRET = process.env.SESSION_SECRET
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be at least 32 characters in production.')
  console.warn('[security] Set SESSION_SECRET to a random value of at least 32 characters.')
}
