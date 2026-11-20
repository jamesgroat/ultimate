import { join } from 'node:path'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { settled } from '../../lib/errors.ts'
import type { FailureClass } from './failure.ts'

export type NoticeClass = Exclude<FailureClass, 'other'>
type Episode = { since: number; delivered?: boolean }
type ProviderEpisodes = Partial<Record<NoticeClass, Episode>>
export type EpisodeFile = {
  open: Record<string, ProviderEpisodes>
  exhausted: Record<string, boolean>
}
export type EpisodeQueue = {
  writes: Promise<unknown>
  delivering: Map<string, Promise<void>>
}

export const episodesPath = (home: string) => join(home, 'health-notices.json')
export const noticeKey = (provider: string, cls: NoticeClass, since: number) =>
  `health:${provider}:${cls}:${since}`
export const noticeSlot = (provider: string) => `health:${provider}`

export function updateEpisodes<T>(
  home: string,
  queue: EpisodeQueue,
  change: (file: EpisodeFile) => T,
): Promise<T> {
  const path = episodesPath(home)
  const operation = settled(queue.writes).then(async () => {
    const stored = await readJson<Partial<EpisodeFile>>(path, {})
    const file: EpisodeFile = { open: stored.open ?? {}, exhausted: stored.exhausted ?? {} }
    const before = JSON.stringify(file)
    const result = change(file)
    if (JSON.stringify(file) !== before) await writeJson(path, file)
    return result
  })
  queue.writes = operation
  return operation
}

export type Undelivered = { provider: string; class: NoticeClass; since: number }

export function step(
  file: EpisodeFile,
  provider: string,
  outcome: { ok: true } | { ok: false; class: FailureClass; at: number },
): Undelivered | undefined {
  if (outcome.ok) {
    delete file.open[provider]
    return undefined
  }
  if (outcome.class === 'other') return undefined
  const episodes = (file.open[provider] ??= {})
  const episode = (episodes[outcome.class] ??= { since: outcome.at })
  return episode.delivered ? undefined : { provider, class: outcome.class, since: episode.since }
}

export function pending(
  file: EpisodeFile,
  provider: string,
  cls: NoticeClass,
): Undelivered | undefined {
  const episode = file.open[provider]?.[cls]
  return episode && !episode.delivered ? { provider, class: cls, since: episode.since } : undefined
}

export function markDelivered(file: EpisodeFile, notice: Undelivered) {
  const episode = file.open[notice.provider]?.[notice.class]
  if (episode?.since === notice.since) episode.delivered = true
}
