import { cn } from 'cn'
import { XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent } from 'react'
import { ToolImage } from '@/components/ai/tool'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../../shared/protocol.ts'
import { errorMessage } from '../sdk/format.ts'

export type PastedImage = { data: string; mimeType: string }

const imageLimitError = 'Paste up to 4 PNG, JPEG, WebP or GIF images, at most 2 MiB each.'

export async function prepareImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') {
    if (file.size > maxImageBytes) throw new Error(imageLimitError)
    return file
  }
  const bitmap = await createImageBitmap(file)
  try {
    if (file.size <= maxImageBytes && Math.max(bitmap.width, bitmap.height) <= 2000) return file
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not resize pasted image')
    let transparent = false
    for (const [edge, quality] of [
      [2000, 0.85],
      [1600, 0.75],
      [1200, 0.65],
    ]) {
      const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height)) * (edge / 2000)
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      if (edge === 2000 && file.type !== 'image/jpeg') {
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
        transparent = data.some((alpha, index) => index % 4 === 3 && alpha < 255)
      }
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, transparent ? 'image/png' : 'image/jpeg', quality),
      )
      if (!blob) throw new Error('Could not resize pasted image')
      if (blob.size <= maxImageBytes) return blob
    }
    throw new Error(imageLimitError)
  } finally {
    bitmap.close()
  }
}

export function useImagePaste({
  images,
  setImages,
  setError,
  disabled,
}: {
  images: PastedImage[]
  setImages: (change: (images: PastedImage[]) => PastedImage[]) => void
  setError: (message: string | undefined) => void
  disabled: () => boolean
}) {
  const [reading, setReading] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled()) {
      event.preventDefault()
      return
    }
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .flatMap((item) => {
        const file = item.getAsFile()
        return file ? [file] : []
      })
    if (!files.length) return
    event.preventDefault()
    await add(files)
  }

  /** Attach the images dropped on the editor; the page itself never navigates to a dropped file (`main.tsx`). */
  async function drop(event: DragEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.dataTransfer.files).filter((file) =>
      file.type.startsWith('image/'),
    )
    if (files.length) await add(files)
  }

  async function add(files: readonly File[]) {
    if (pending.current || disabled()) return
    if (
      images.length + files.length > maxImages ||
      files.some((file) => !imageMimeTypes.includes(file.type))
    ) {
      setError(imageLimitError)
      return
    }
    pending.current = true
    setReading(true)
    setError(undefined)
    try {
      const added = await Promise.all(
        files.map(async (file) => {
          const blob = await prepareImage(file)
          return new Promise<PastedImage>((resolve, reject) => {
            const reader = new FileReader()
            reader.addEventListener('load', () => {
              if (typeof reader.result !== 'string')
                return reject(new Error('Could not read pasted image'))
              resolve({ data: reader.result.split(',')[1], mimeType: blob.type })
            })
            reader.addEventListener('error', () => reject(new Error('Could not read pasted image')))
            reader.readAsDataURL(blob)
          })
        }),
      )
      if (alive.current) setImages((current) => [...current, ...added])
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure))
    } finally {
      pending.current = false
      if (alive.current) setReading(false)
    }
  }

  return { paste, drop, reading, pending }
}

export function ImagePreviews({
  images,
  remove,
  disabled,
  className,
}: {
  images: PastedImage[]
  remove: (index: number) => void
  disabled: boolean
  className?: string
}) {
  return images.length > 0 ? (
    <div className={cn('flex flex-wrap gap-2 px-3 pt-3', className)}>
      {images.map((image, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Pasted images have no id and may repeat.
        <div className="relative" key={index}>
          <ToolImage
            alt={`Pasted image ${index + 1}`}
            className="max-w-36 [&_img]:max-h-24"
            image={image}
          />
          <button
            aria-label={`Remove image ${index + 1}`}
            className="absolute -top-2 -right-2 flex size-5 cursor-pointer items-center justify-center rounded-full border bg-background hover:bg-accent"
            disabled={disabled}
            onClick={() => remove(index)}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  ) : null
}
