import { readFile, writeFile, access } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { exec } from '../../../lib/exec.ts'
import { localTranscript } from '../local.ts'
import { createPlayer, splitSentences } from '../speech.ts'
import { createMic } from '../recorder.ts'
import { actions } from '../server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { ActionContext } from '../../../server/actions.ts'

vi.mock('../../../lib/exec.ts', () => ({ exec: vi.fn<typeof exec>() }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('does not report canceled silent unlock playback as a voice failure, but keeps real failures visible', async () => {
  const aborted = new DOMException('The operation was aborted', 'AbortError')
  let rejectUnlock!: (error: unknown) => void
  const play = vi.fn<() => Promise<void>>().mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectUnlock = reject
      }),
  )
  class PendingAudio {
    src = ''
    playbackRate = 1
    play = play
    pause() {
      rejectUnlock?.(aborted)
    }
    addEventListener() {}
  }
  vi.stubGlobal('Audio', PendingAudio)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local')
  const error = vi.fn<(failure: unknown) => void>()
  const player = createPlayer({
    enabled: () => true,
    listening: () => false,
    rate: () => 1,
    frame: () => () => {},
    error,
    render: async () => ({ audio: 'AQACAA==', mimeType: 'audio/mp4' }),
  })
  player.unlock()
  player.load('reply', splitSentences('A reply.', true).sentences, false)
  await Promise.resolve()
  expect(error).not.toHaveBeenCalled()

  const denied = new DOMException('Playback denied', 'NotAllowedError')
  play.mockRejectedValue(denied)
  player.unlock()
  await Promise.resolve()
  expect(error).toHaveBeenCalledWith(denied)
  error.mockClear()
  play.mockRejectedValue(aborted)
  player.play(0)
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith(aborted))
  expect(player.state.get()).toMatchObject({ playing: false, paused: true })

  const getUserMedia = vi.fn<() => Promise<MediaStream>>().mockRejectedValue(aborted)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  await expect(createMic(() => () => {}).start()).rejects.toBe(aborted)
})

it('decodes the recording to mono PCM16 before local STT, and removes temporary audio on success and error', async () => {
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
    expect(await readFile(args![4])).toEqual(Buffer.from('encoded clip'))
    output = args!.at(-1)!
    await writeFile(output, Buffer.from([1, 0, 2, 0]))
    return { stdout: '', stderr: '' }
  })
  const invoke = vi.fn<ExtensionHost['invoke']>().mockResolvedValue({ text: ' local words ' })
  const host = { invoke } as unknown as ExtensionHost
  const signal = new AbortController().signal
  const clip = { data: Buffer.from('encoded clip').toString('base64'), mimeType: 'audio/mp4' }
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
})

it('renders locally and cancels pending and playing sentences without a browser speech fallback', async () => {
  const elements: FakeAudio[] = []
  class FakeAudio {
    src = ''
    currentTime = 0
    duration = 2
    playbackRate = 1
    addEventListener = vi.fn<(type: string, listener: () => void, options: unknown) => void>()
    play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    pause = vi.fn<() => void>()
    constructor() {
      elements.push(this)
    }
  }
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('speechSynthesis', {
    speak: vi.fn<() => void>(() => {
      throw new Error('No browser fallback')
    }),
  })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const invoke = vi
    .fn<ExtensionHost['invoke']>()
    .mockResolvedValue({ audio: 'AQACAA==', mimeType: 'audio/mp4' })
  const error = vi.fn<(failure: unknown) => void>()
  const ctx = { host: { invoke }, signal: new AbortController().signal } as unknown as ActionContext
  let pendingSignal: AbortSignal | undefined
  let finish!: (result: { audio: string; mimeType: string }) => void
  const render = vi.fn<
    (text: string, signal: AbortSignal) => Promise<{ audio: string; mimeType: string }>
  >((text, signal) => {
    pendingSignal = signal
    return actions.render({ text }, { ...ctx, signal })
  })
  const player = createPlayer({
    enabled: () => true,
    listening: () => false,
    rate: () => 1,
    frame: () => () => {},
    render,
    error,
  })
  player.load('reply', splitSentences('First sentence. Second sentence.', true).sentences, false)
  player.play(0)
  await vi.waitFor(() => expect(elements[0].src).toBe('blob:local'))
  expect(invoke).toHaveBeenCalledWith(
    'speak',
    'render',
    { text: 'First sentence.', engine: 'mlx' },
    expect.any(AbortSignal),
  )
  player.pause()
  expect(pendingSignal!.aborted).toBe(true)
  expect(elements[0].pause).toHaveBeenCalled()
  expect(revoke).toHaveBeenCalledWith('blob:local')
  render.mockImplementation((_text, signal) => {
    pendingSignal = signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  player.sentence(1)
  player.stop()
  finish({ audio: 'AQACAA==', mimeType: 'audio/mp4' })
  await Promise.resolve()
  expect(player.state.get()).toMatchObject({ playing: false, paused: false })
  expect(pendingSignal!.aborted).toBe(true)
  render.mockRejectedValue(new Error('Kokoro unavailable'))
  player.play(0)
  await vi.waitFor(() =>
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Kokoro unavailable' })),
  )
  expect(player.state.get().paused).toBe(true)
})
