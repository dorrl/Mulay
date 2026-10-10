export type User = { id: string; name: string; email: string; avatar: string; admin: boolean }
export type Track = { id: string; videoId: string; title: string; channel: string; thumbnail: string; addedBy: string; addedAt: number; votes: Record<string, 1 | -1> }
export type ChatMessage = { id: string; userId: string; name: string; avatar: string; text: string; at: number }
export type RoomState = {
  current: Track | null; queue: Track[]; history: { videoId: string; addedAt: number }[]
  startedAt: number | null; pausedAt: number | null; paused: boolean
  announcement: { id: string; text: string; at: number } | null; bannedUsers: string[]; chat: ChatMessage[]
}
export const blankState = (): RoomState => ({
  current: null, queue: [], history: [], startedAt: null, pausedAt: null,
  paused: false, announcement: null, bannedUsers: [], chat: [],
})
