const parseDuration = (value: string): number => {
  const match = /^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?$/.exec(value)
  if (!match) throw new Error('Invalid YouTube duration')
  return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0)
}

export type YouTubeVideoDetails = { durations: Map<string, number>; liveVideoIds: Set<string> }

export const fetchVideoDetails = async (videoIds: string[]): Promise<YouTubeVideoDetails> => {
  const durations = new Map<string, number>()
  const liveVideoIds = new Set<string>()
  if (!videoIds.length) return { durations, liveVideoIds }
  const key = process.env.YOUTUBE_API_KEY
  if (!key) throw new Error('YOUTUBE_API_KEY is not configured')
  const url = new URL('https://www.googleapis.com/youtube/v3/videos')
  url.search = new URLSearchParams({ part: 'contentDetails,snippet,liveStreamingDetails', id: [...new Set(videoIds)].join(','), key }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error('YouTube video details request failed: ' + response.status)
  const body = await response.json() as { items?: { id: string; contentDetails?: { duration?: string }; snippet?: { liveBroadcastContent?: string }; liveStreamingDetails?: Record<string, unknown> }[] }
  for (const item of body.items ?? []) {
    if (item.contentDetails?.duration) durations.set(item.id, parseDuration(item.contentDetails.duration))
    if (item.snippet?.liveBroadcastContent === 'live' || item.snippet?.liveBroadcastContent === 'upcoming' || item.liveStreamingDetails) liveVideoIds.add(item.id)
  }
  return { durations, liveVideoIds }
}

export const fetchVideoDurations = async (videoIds: string[]): Promise<Map<string, number>> => {
  return (await fetchVideoDetails(videoIds)).durations
}
