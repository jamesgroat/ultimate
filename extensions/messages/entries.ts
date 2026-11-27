import { defineEntry, type EntryRecord } from '@earendil-works/pi-durable'
import { imagesOf as modelImagesOf } from '../../lib/entries.ts'
import type { QuestionNotice } from './refs.ts'

export const AskedEntry = defineEntry<QuestionNotice>('board.asked')

export const AnsweredEntry = defineEntry<QuestionNotice>('board.answered')

export const ForwardedImages = defineEntry<{
  images: { type: 'image'; data: string; mimeType: string }[]
}>('board.images')

export function imagesOf(entry: EntryRecord | undefined) {
  return entry && ForwardedImages.is(entry) ? entry.data.images : modelImagesOf(entry)
}
