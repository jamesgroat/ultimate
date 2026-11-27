import { access, readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { exec } from '../../../lib/exec.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { localTranscript } from '../local.ts'

vi.mock('../../../lib/exec.ts', () => ({ exec: vi.fn<typeof exec>() }))
afterEach(() => vi.restoreAllMocks())

it('converts phone recordings to Parakeet mono PCM16 and cleans up after success or failure', async () => {
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
  await expect(localTranscript(host, clip, signal)).rejects.toThrow('worker unavailable')
  await expect(access(output)).rejects.toThrow('ENOENT')
})
