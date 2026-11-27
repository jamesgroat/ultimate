import type { ConversationId, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { int, lit, union } from '@earendil-works/pi-schema'
import { resizeImage } from '@earendil-works/pi-coding-agent'
import { latestImagesEntry } from '../../lib/entries.ts'
import { ForwardedImages, imagesOf } from './entries.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'

export type ImagesRef = 'latest' | EntryId
export const SCAN_PAGE = 200

export async function resolveImages(tx: Tx, from: ConversationId, ref: ImagesRef) {
  let entry: EntryRecord | undefined
  if (ref === 'latest') entry = await latestImagesEntry(tx, from)
  else {
    if (!Number.isInteger(ref) || ref < 1)
      throw new Error('images must be "latest" or the id of an entry with images')
    entry = (
      await tx.scanEntries(
        {
          conversationId: from,
          minEntryId: ref,
          maxEntryId: ref,
        },
        1,
      )
    ).items[0]
    if (!entry) throw new Error(`images: entry ${ref} is not in this conversation`)
  }
  const images = imagesOf(entry)
  if (!images.length) throw new Error(`images: entry ${entry.id} has no images`)
  if (images.length > maxImages)
    throw new Error(
      `images: entry ${entry.id} has ${images.length} images; at most ${maxImages} go along`,
    )
  let compressed = ForwardedImages.is(entry)
  for (const [index, image] of images.entries()) {
    const refused = new Error(
      `images: entry ${entry.id} has an unsupported image or one over 2 MiB`,
    )
    if (!imageMimeTypes.includes(image.mimeType)) throw refused
    if (Buffer.byteLength(image.data, 'utf8') < maxImageBytes) continue
    const resized = await resizeImage(Buffer.from(image.data, 'base64'), image.mimeType, {
      maxWidth: Number.MAX_SAFE_INTEGER,
      maxHeight: Number.MAX_SAFE_INTEGER,
      maxBytes: maxImageBytes,
    })
    if (!resized || Buffer.byteLength(resized.data, 'utf8') >= maxImageBytes) throw refused
    images[index] = { type: 'image', data: resized.data, mimeType: resized.mimeType }
    compressed = true
  }
  const prepared =
    compressed && !ForwardedImages.is(entry)
      ? await tx.appendEntry(from, { kind: ForwardedImages.kind, data: { images } })
      : entry
  return { entry: prepared.id, count: images.length, compressed }
}
export const imagesParameter = union([lit('latest'), int({ minimum: 1 })], {
  description:
    'Forward images from your conversation: "latest" for those of this turn (your current input, or a tool result such as a screenshot since; it fails when there are none), or an entry id for older ones.',
})
