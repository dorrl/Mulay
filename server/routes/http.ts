import type { Router } from 'express'
import passport from 'passport'
import { z } from 'zod'
import { currentUser, publicUser, requireAdmin, requireUser } from '../auth.js'
import { WEB_ORIGIN } from '../config.js'
import { connectedUsers } from '../runtime.js'
import { state } from '../storage/room-store.js'
import { publicState } from '../services/room.js'
import { fetchVideoDurations } from '../services/youtube.js'
export const registerHttpRoutes = (app: Router) => {
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  app.get('/api/me', (req, res) => {
    const user = currentUser(req)
    res.json({ user: user && !state.bannedUsers.includes(user.id) ? publicUser(user) : null,
      googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) })
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
      res.clearCookie('mulay.sid'); res.json({ ok: true })
    })
  }))
  app.get('/api/search', async (req, res) => {
    const query = z.string().trim().min(1).max(100).safeParse(req.query.q)
    if (!query.success) return res.status(400).json({ error: '검색어를 1~100자로 입력하세요.' })
    if (!process.env.YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube Data API 키가 설정되지 않았습니다.' })
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/search')
      url.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '8', q: query.data,
        key: process.env.YOUTUBE_API_KEY, videoEmbeddable: 'true', safeSearch: 'moderate' }).toString()
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!response.ok) {
        const detail = await response.text()
        console.error('[youtube] Search request failed:', response.status, detail.slice(0, 1000))
        return res.status(502).json({ error: 'YouTube 검색에 실패했습니다.' })
      }
      const body = await response.json() as { items?: { id: { videoId?: string }; snippet: { title: string; channelTitle: string; thumbnails?: { medium?: { url?: string }; high?: { url?: string } } } }[] }
      const found = (body.items ?? []).filter(item => item.id.videoId)
      const durations = await fetchVideoDurations(found.map(item => item.id.videoId!))
      const items = found.flatMap(item => {
        const videoId = item.id.videoId!
        const durationSeconds = durations.get(videoId)
        if (durationSeconds === undefined) return []
        return [{ videoId, title: item.snippet.title, channel: item.snippet.channelTitle, thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.high?.url || '', durationSeconds }]
      })
      res.json({ items })
    } catch {
      res.status(502).json({ error: 'YouTube 검색 또는 영상 길이 확인에 실패했습니다.' })
    }
  })
  app.get('/api/admin/users', requireUser, requireAdmin, (_req, res) => {
    const activeUsers = Array.from(new Map(Array.from(connectedUsers.values()).map(u => [u.id, publicUser(u)])).values())
    res.json({ bannedUsers: state.bannedUsers, activeUsers })
  })
}
