/** Review for other extensions' browser code: open a review, provide an optional source picker, and call its actions. */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

/** An optional source picker; sources are opaque identifiers resolved by the server's `review.sources` provider. */
export const SourcePicker = definePoint<
  { source?: string; select: (source: string | undefined) => void },
  ReactNode
>('review.source-picker')
export { openReview } from './link.tsx'
export type { ReviewTarget } from './link.tsx'
export { DiffAction, RangesAction, RecipientAction, SendAction } from './refs.ts'
export type { ReviewDiff, ReviewFile, ReviewKind, ReviewRange } from './refs.ts'
