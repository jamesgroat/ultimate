/** Review's source picker point, navigation types and actions for other browser extensions. */
import type { JSX } from '@solidjs/web'
import { definePoint } from '@/sdk/solid'

/** Optional source picker; opaque source ids are resolved by the server's review.sources provider. */
export const SourcePicker = definePoint<
  { source?: string; select: (source: string | undefined) => void },
  JSX.Element
>('review.source-picker')
export type { ReviewTarget, ReviewRequest } from './link-state.ts'
export { DiffAction, RangesAction, RecipientAction, SendAction } from './refs.ts'
export type { ReviewDiff, ReviewRange, ReviewFile, ReviewKind } from './refs.ts'
