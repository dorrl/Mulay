import session from 'express-session'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { DATA_DIR, SESSION_FILE } from '../config.js'
type StoredSession = { expiresAt: number; data: session.SessionData }

export class JsonSessionStore extends session.Store {
  private sessions: Record<string, StoredSession> = {}
  private readonly loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  constructor() { super(); this.loaded = this.load() }

  private async load() {
    await mkdir(DATA_DIR, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(SESSION_FILE, 'utf8')) as Record<string, StoredSession>
      const now = Date.now()
      this.sessions = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v && v.expiresAt > now && v.data))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[storage] Could not read session JSON:', error)
      this.sessions = {}
    }
    await this.persist()
  }

  private persist() {
    const snapshot = JSON.stringify(this.sessions, null, 2)
    this.writes = this.writes.then(async () => {
      await mkdir(DATA_DIR, { recursive: true })
      const temp = SESSION_FILE + '.tmp'
      await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, SESSION_FILE)
    })
    return this.writes
  }

  get(sid: string, callback: (err: any, value?: session.SessionData | null) => void) {
    void this.loaded.then(async () => {
      const record = this.sessions[sid]
      if (record && record.expiresAt <= Date.now()) { delete this.sessions[sid]; await this.persist() }
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
    void this.loaded.then(() => { delete this.sessions[sid]; return this.persist() })
      .then(() => callback?.(null)).catch((error) => callback?.(error))
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
