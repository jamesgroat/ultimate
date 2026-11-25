import { access, readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { exec } from '../../../lib/exec.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { localSpeech, localTranscript } from '../local.ts'

vi.mock('../../../lib/exec.ts', () => ({ exec: vi.fn<typeof exec>() }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('decodes local STT to mono PCM16 and cleans up on success or local failure without a paid fallback', async () => {
  let output = ''
  vi.mocked(exec).mockImplementation(async (command, args) => {
    expect(command).toBe('ffmpeg')
    expect(args).toEqual([
      '-nostdin',
      '-v',
      'error',
      '-i',
      expect.any(String),
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      expect.any(String),
    ])
    expect(await readFile(args![4])).toEqual(Buffer.from('clip'))
    output = args!.at(-1)!
    await writeFile(output, Buffer.from([1, 0, 2, 0]))
    return { stdout: '', stderr: '' }
  })
  const invoke = vi.fn<ExtensionHost['invoke']>().mockResolvedValue({ text: ' local words ' })
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  const host = { invoke } as unknown as ExtensionHost
  const signal = new AbortController().signal
  const clip = { data: Buffer.from('clip').toString('base64'), mimeType: 'audio/mp4' }
  expect(await localTranscript(host, clip, signal)).toBe('local words')
  expect(invoke).toHaveBeenCalledWith(
    'speak',
    'transcribe',
    { pcm: 'AQACAA==', turn: false },
    signal,
  )
  await expect(access(output)).rejects.toThrow('ENOENT')
  invoke.mockRejectedValue(new Error('worker unavailable'))
  await expect(localTranscript(host, clip, signal)).rejects.toThrow(
    'Local Parakeet transcription failed',
  )
  await expect(access(output)).rejects.toThrow('ENOENT')
  expect(fetch).not.toHaveBeenCalled()
})

it('renders Kokoro locally, preserves MIME, and rejects local failures or cancelled results without fallback', async () => {
  const invoke = vi
    .fn<ExtensionHost['invoke']>()
    .mockResolvedValue({ audio: 'AQACAA==', mimeType: 'audio/mp4' })
  const host = { invoke } as unknown as ExtensionHost
  const controller = new AbortController()
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  expect(await localSpeech(host, 'Hello.', controller.signal)).toEqual({
    audio: 'AQACAA==',
    mimeType: 'audio/mp4',
  })
  expect(invoke).toHaveBeenCalledWith(
    'speak',
    'render',
    { text: 'Hello.', engine: 'mlx' },
    controller.signal,
  )
  invoke.mockRejectedValue(new Error('missing worker'))
  await expect(localSpeech(host, 'Hello.', controller.signal)).rejects.toThrow(
    'Local Kokoro rendering failed',
  )
  const pending = Promise.withResolvers<unknown>()
  invoke.mockReturnValue(pending.promise)
  const cancelled = localSpeech(host, 'Hello.', controller.signal)
  controller.abort(new Error('stopped'))
  pending.resolve({ audio: 'late', mimeType: 'audio/mp4' })
  await expect(cancelled).rejects.toThrow('stopped')
  expect(fetch).not.toHaveBeenCalled()
})
