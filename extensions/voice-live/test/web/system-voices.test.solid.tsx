import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  spoken: [] as string[],
  said: [] as string[],
  fail: false,
  sources: [] as string[],
}))
vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    api: {
      action: (ref: { name: string }, args: { text: string }) => {
        if (ref.name !== 'speak') throw new Error(`Unexpected action: ${ref.name}`)
        harness.spoken.push(args.text)
        return harness.fail
          ? Promise.reject(new Error('Local worker unavailable'))
          : Promise.resolve({ audio: 'AQACAA==', mimeType: 'audio/mp4' })
      },
    },
    errorMessage: String,
    ROOT: 1,
    useConversation: () => () => ({ entries: [], live: {}, busy: false }),
    useUiState: (key: string, initial: unknown) =>
      createSignal<unknown>(key === 'ext.voice-live.cues' ? false : initial),
  }
})

beforeEach(() => {
  vi.resetModules()
  harness.spoken.length = 0
  harness.said.length = 0
  harness.sources.length = 0
  harness.fail = false
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => [{ name: 'Available system voice' }],
    speak: () => harness.said.push('browser fallback'),
  })
  vi.stubGlobal(
    'Audio',
    class extends EventTarget {
      src = ''
      duration = 1
      playbackRate = 1
      pause() {}
      play() {
        harness.sources.push(this.src)
        this.dispatchEvent(new Event('playing'))
        return Promise.resolve()
      }
    },
  )
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => vi.unstubAllGlobals())

it('plays local MIME-aware audio even with system voices available, and fails explicitly without fallback', async () => {
  const { dock } = await import('../../dock.solid.tsx')
  const { splitSentences } = await import('../../speech.ts')
  const say = () => {
    dock.player.load('reply', [], true)
    dock.player.push('reply', splitSentences('Hello there.', true).sentences[0])
  }
  say()
  await vi.waitFor(() => expect(harness.sources).toEqual(['data:audio/mp4;base64,AQACAA==']))
  dock.player.stop()
  harness.fail = true
  say()
  await vi.waitFor(() => expect(dock.error()).toContain('Local worker unavailable'))
  expect(harness.said).toEqual([])
  expect(dock.player.state.get().playing).toBe(false)
})
