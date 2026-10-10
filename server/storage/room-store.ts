import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { DATA_DIR, DATA_FILE } from '../config.js'
import { blankState, type RoomState } from '../types.js'
export const state: RoomState = blankState()
let writeChain: Promise<void> = Promise.resolve()
export const persist = () => {
  const snapshot = JSON.stringify(state, null, 2)
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true })
    const temp = DATA_FILE + '.tmp'
    await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, DATA_FILE)
  }).catch((error) => console.error('[storage] Could not persist room state:', error))
  return writeChain
}
export const loadState = async () => {
  await mkdir(DATA_DIR, { recursive: true })
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, 'utf8')) as Partial<RoomState>
    Object.assign(state, { ...blankState(), ...parsed, queue: parsed.queue ?? [], history: parsed.history ?? [], bannedUsers: parsed.bannedUsers ?? [], chat: parsed.chat ?? [] })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[storage] Invalid room data; starting with an empty room.', error)
    await persist()
  }
}
