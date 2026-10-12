import 'dotenv/config'
import express, { Router } from 'express'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import session from 'express-session'
import passport from 'passport'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { Server } from 'socket.io'
import { PORT, SESSION_SECRET } from './config.js'
import { configurePassport } from './auth.js'
import { JsonSessionStore } from './storage/json-session-store.js'
import { loadState } from './storage/room-store.js'
import { registerHttpRoutes } from './routes/http.js'
import { registerSocketHandlers } from './socket/handlers.js'

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  path: '/server/socket.io',
  cors: { origin: process.env.WEB_ORIGIN || 'http://localhost:33541', credentials: true },
  maxHttpBufferSize: 1e6,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
})
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false)
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.youtube.com', 'https://s.ytimg.com', 'https://apis.google.com'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:', 'https://i.ytimg.com', 'https://*.googleusercontent.com', 'https://*.ggpht.com'],
    frameSrc: ["'self'", 'https://www.youtube.com', 'https://youtube.com', 'https://accounts.google.com'],
    connectSrc: ["'self'", 'https://www.googleapis.com', 'https://www.youtube.com', 'wss:', 'ws:'],
  } },
}))
app.use(express.json({ limit: '32kb' }))
app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }))
const sessionMiddleware = session({
  name: 'mulay.sid',
  secret: SESSION_SECRET || 'development-only-secret-change-before-deploy',
  resave: false, saveUninitialized: false, store: new JsonSessionStore(),
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 },
})
app.use(sessionMiddleware)
configurePassport()
app.use(passport.initialize())
app.use(passport.session())
io.engine.use(sessionMiddleware as never)
io.engine.use(passport.initialize() as never)
io.engine.use(passport.session() as never)
const serverRouter = Router()
registerHttpRoutes(serverRouter)
app.use('/server', serverRouter)
registerSocketHandlers(io)

// Both development and production serve the built frontend and API from this origin.
const clientDir = path.resolve(process.cwd(), 'dist/public')
if (existsSync(path.join(clientDir, 'index.html'))) {
  app.use(express.static(clientDir, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }))
  app.use((req, res, next) => {
    if (req.path.startsWith('/server/')) return next()
    res.sendFile(path.join(clientDir, 'index.html'))
  })
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[http]', error)
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' })
})
await loadState()
await new Promise<void>((resolve, reject) => {
  httpServer.once('error', reject)
  httpServer.listen(PORT, resolve)
})
console.log('Mulay server listening on :' + PORT)
