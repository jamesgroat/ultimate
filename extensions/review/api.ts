/** Optional trusted repositories for Review; providers resolve opaque source ids, never browser paths. */
import { defineApi } from '../../shared/extension-api.ts'
import type { ReviewRange } from './refs.ts'

export type ReviewSourcesService = {
  /** Resolve a trusted checkout on every operation. Throw if the source was removed or is invalid. */
  resolve(source: string): Promise<{
    cwd: string
    label: string
    base?: string
    recipient?: number
    github?: string
  }>
  /** Choices for this source, without replacing Review's diff or send implementation. */
  ranges(source: string): Promise<ReviewRange[]>
}

/** Optional source provider; Review works natively when no source is selected. */
export const ReviewSources = defineApi<ReviewSourcesService>()('review.sources')
