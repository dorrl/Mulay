import type { NextFunction, Request, Response } from 'express'
import passport from 'passport'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20'
import { state } from './storage/room-store.js'
import { safeUser } from './services/room.js'
import type { User } from './types.js'
export const configurePassport = () => {
  passport.serializeUser((user, done) => done(null, user))
  passport.deserializeUser((user: Express.User, done) => done(null, user))
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return
  const admins = new Set((process.env.ADMIN_GOOGLE_IDS || '').split(',').map(v => v.trim()).filter(Boolean))
  const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean))
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/auth/google/callback',
    scope: ['profile', 'email'], state: true,
  }, (_accessToken, _refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || ''
    const emailVerified = profile._json.email_verified === true
    const user: User = {
      id: profile.id, name: (profile.displayName || 'Listener').slice(0, 80), email: email.slice(0, 254),
      avatar: profile.photos?.[0]?.value || '',
      admin: admins.has(profile.id) || (emailVerified && adminEmails.has(email.toLowerCase())),
    }
    done(null, user)
  }))
}
export const requireUser = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as User | undefined
  if (!user) return res.status(401).json({ error: 'Google 로그인이 필요합니다.' })
  if (state.bannedUsers.includes(user.id)) return res.status(403).json({ error: '이 계정은 이용이 제한되었습니다.' })
  next()
}
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!(req.user as User | undefined)?.admin) return res.status(403).json({ error: '관리자 권한이 필요합니다.' })
  next()
}
export const currentUser = (req: Request) => req.user as User | undefined
export const publicUser = safeUser
