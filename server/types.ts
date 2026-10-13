export type User = { id: string; name: string; email: string; avatar: string; admin: boolean }
export type Track = { id: string; videoId: string; title: string; channel: string; thumbnail: string; durationSeconds?: number; addedBy: string; addedByName?: string; addedByAvatar?: string; addedAt: number; votes: Record<string, 1 | -1> }
export type ChatMessage = { id: string; userId: string; name: string; avatar: string; text: string; at: number; admin?: boolean }
export type RoomState = {
  current: Track | null; queue: Track[]; history: { videoId: string; addedAt: number; addedBy?: string }[]
  startedAt: number | null; pausedAt: number | null; paused: boolean
  announcement: { id: string; text: string; at: number } | null; bannedUsers: string[]; chat: ChatMessage[]
  recommendationCooldownMinutes: number
}
export const blankState = (): RoomState => ({
  current: null, queue: [], history: [], startedAt: null, pausedAt: null,
  paused: false, announcement: null, bannedUsers: [], chat: [], recommendationCooldownMinutes: 5,
})
