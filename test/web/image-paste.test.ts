import { afterEach, expect, it, vi } from 'vitest'
import { prepareImage } from '../../web/src/components/image-paste.tsx'
import { maxImageBytes } from '../../shared/protocol.ts'

afterEach(() => vi.unstubAllGlobals())

it('resizes a large photo to fit the attachment limit, retrying at a smaller size', async () => {
  const close = vi.fn<() => void>()
  vi.stubGlobal('createImageBitmap', async () => ({ width: 5712, height: 4284, close }))
  const drawImage =
    vi.fn<(image: ImageBitmap, x: number, y: number, w: number, h: number) => void>()
  const result = new Blob(['resized'], { type: 'image/jpeg' })
  const toBlob = vi
    .fn<HTMLCanvasElement['toBlob']>()
    .mockImplementationOnce((done) => done(new Blob([new Uint8Array(maxImageBytes + 1)])))
    .mockImplementationOnce((done) => done(result))
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob }
  vi.stubGlobal('document', { createElement: () => canvas })

  const file = new File([new Uint8Array(maxImageBytes + 1)], 'photo.jpg', { type: 'image/jpeg' })
  expect(await prepareImage(file)).toBe(result)
  expect(drawImage.mock.calls.map((call) => call.slice(1))).toEqual([
    [0, 0, 2000, 1500],
    [0, 0, 1600, 1200],
  ])
  expect(toBlob.mock.calls.map((call) => call.slice(1))).toEqual([
    ['image/jpeg', 0.85],
    ['image/jpeg', 0.75],
  ])
  expect(close).toHaveBeenCalledOnce()
})

it('reduces dimensions on retries for a byte-heavy transparent image below the edge limit', async () => {
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1000, height: 1000, close() {} }))
  const drawImage =
    vi.fn<(image: ImageBitmap, x: number, y: number, w: number, h: number) => void>()
  const getImageData = () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) })
  const result = new Blob(['resized'], { type: 'image/png' })
  const toBlob = vi
    .fn<HTMLCanvasElement['toBlob']>()
    .mockImplementationOnce((done) => done(new Blob([new Uint8Array(maxImageBytes + 1)])))
    .mockImplementationOnce((done) => done(result))
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => ({ drawImage, getImageData }), toBlob }),
  })
  const file = new File([new Uint8Array(maxImageBytes + 1)], 'transparent.png', {
    type: 'image/png',
  })
  expect(await prepareImage(file)).toBe(result)
  expect(drawImage.mock.calls.map((call) => call.slice(1))).toEqual([
    [0, 0, 1000, 1000],
    [0, 0, 800, 800],
  ])
  expect(toBlob.mock.calls.map((call) => call[1])).toEqual(['image/png', 'image/png'])
})

it('keeps an image within the size and dimension limits unchanged', async () => {
  const close = vi.fn<() => void>()
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1200, height: 900, close }))
  const file = new File([new Uint8Array(500_000)], 'photo.jpg', { type: 'image/jpeg' })
  expect(await prepareImage(file)).toBe(file)
  expect(close).toHaveBeenCalledOnce()
})
