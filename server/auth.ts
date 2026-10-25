import type { NextFunction, Request, Response } from 'express'
import passport from 'passport'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20'
import { state } from './storage/room-store.js'
import { safeUser } from './services/room.js'
import type { User } from './types.js'

const envList = (value: string | undefined) => new Set((value || '').split(',').map(item => item.trim()).filter(Boolean))

// The only authority for roles is the Google identity stored in the signed server session
// plus the server-side allowlists. Never authorize from a client-provided admin property.
export const isAdminUser = (user: User | undefined | null): user is User => {
  if (!user) return false
  if (envList(process.env.ADMIN_GOOGLE_IDS).has(user.id)) return true
  return user.emailVerified === true && envList(process.env.ADMIN_EMAILS).has(user.email.toLowerCase())
}

export const isBannedUser = (user: User | undefined | null) => Boolean(user && state.bannedUsers.includes(user.id))

export const configurePassport = () => {
  passport.serializeUser((user, done) => done(null, user))
  passport.deserializeUser((serialized: Express.User, done) => {
    const user = serialized as User
    // Recompute role on every request from server configuration; do not preserve stale
    // privileges if an allowlist changes while an old session is still alive.
    done(null, { ...user, admin: isAdminUser(user) })
  })
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/server/auth/google/callback',
    scope: ['profile', 'email'], state: true,
  }, (_accessToken, _refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || ''
    const emailVerified = profile._json.email_verified === true
    const user: User = {
      id: profile.id, name: (profile.displayName || 'Listener').slice(0, 80),
      email: email.slice(0, 254), emailVerified,
      avatar: profile.photos?.[0]?.value || '',
      admin: envList(process.env.ADMIN_GOOGLE_IDS).has(profile.id) ||
        (emailVerified && envList(process.env.ADMIN_EMAILS).has(email.toLowerCase())),
    }
    done(null, user)
  }))
}

export const requireUser = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as User | undefined
  if (!user) return res.status(401).json({ error: 'Google 로그인이 필요합니다.' })
  if (isBannedUser(user)) return res.status(403).json({ error: '이 계정은 이용이 제한되었습니다.' })
  next()
}

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user as User | undefined
  if (!user || isBannedUser(user) || !isAdminUser(user)) {
    return res.status(403).json({ error: '관리자 권한이 필요합니다.' })
  }
  next()
}

export const currentUser = (req: Request) => req.user as User | undefined
export const publicUser = (user: User) => safeUser({ ...user, admin: isAdminUser(user) })
