import type { VoicePause } from './refs.ts'

export const PAUSES: Record<'relaxed' | 'snappy', VoicePause> = {
  relaxed: { cutMs: 900, holdMs: 12_000 },
  snappy: { cutMs: 400, holdMs: 1600 },
}

export const NUDGE_FIRST_MS = 30_000
export const NUDGE_REPEAT_MS = 60_000
