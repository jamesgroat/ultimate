import { join } from 'node:path'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { settled } from '../../lib/errors.ts'
import type { FailureClass } from './failure.ts'

export type NoticeClass = Exclude<FailureClass, 'other'>
type Episode = { class: NoticeClass; since: number }
export type EpisodeFile = {
  open: Record<string, Episode>
  exhausted: Record<string, boolean>
}

export const episodesPath = (home: string) => join(home, 'health-notices.json')
export const noticeKey = (provider: string, episode: Episode) =>
  `health:${provider}:${episode.class}:${episode.since}`
export const noticeSlot = (provider: string) => `health:${provider}`

const queues = new Map<string, Promise<unknown>>()
export function updateEpisodes<T>(home: string, change: (file: EpisodeFile) => T): Promise<T> {
  const path = episodesPath(home)
  const operation = settled(queues.get(path) ?? Promise.resolve()).then(async () => {
    const stored = await readJson<Partial<EpisodeFile>>(path, {})
    const file: EpisodeFile = { open: stored.open ?? {}, exhausted: stored.exhausted ?? {} }
    const before = JSON.stringify(file)
    const result = change(file)
    if (JSON.stringify(file) !== before) await writeJson(path, file)
    return result
  })
  queues.set(path, operation)
  return operation
}
export function step(
  file: EpisodeFile,
  provider: string,
  outcome: { ok: true } | { ok: false; class: FailureClass; at: number },
): Episode | undefined {
  if (outcome.ok) {
    delete file.open[provider]
    return undefined
  }
  if (outcome.class === 'other') return undefined
  if (file.open[provider]?.class === outcome.class) return undefined
  return (file.open[provider] = { class: outcome.class, since: outcome.at })
}
