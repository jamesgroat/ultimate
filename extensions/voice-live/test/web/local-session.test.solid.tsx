/** @jsxImportSource @solidjs/web */
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { ActionRef } from '../../../../shared/extension-api.ts'

const harness = vi.hoisted(() => ({
  action: vi.fn<(ref: ActionRef<unknown, unknown>, args: unknown) => Promise<unknown>>(),
}))
vi.mock('@/sdk/solid', () => ({
  api: { action: harness.action },
  errorMessage: String,
  events: { emit: () => undefined },
}))
vi.mock('../../../sounds/ui.solid.tsx', () => ({
  playNotes: async () => undefined,
  voiceQuestions: () => undefined,
}))

import * as live from '../../live.solid.tsx'

it('runs local audio on Solid and delivers a line after 400 ms without waiting for completion', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  onTestFinished(() => {
    live.end()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  let capture: { onaudioprocess: ((event: unknown) => void) | null } | undefined
  const track = { stop: vi.fn<() => void>() }
  const getUserMedia = vi.fn<() => Promise<unknown>>(async () => ({ getTracks: () => [track] }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  const node = () => ({ connect: () => node() })
  const param = () => ({
    value: 0,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
    cancelScheduledValues: () => undefined,
  })
  const playback: EventTarget[] = []
  const stop = vi.fn<() => void>(() => playback.at(-1)?.dispatchEvent(new Event('ended')))
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running'
      currentTime = 0
      sampleRate = 16000
      destination = {}
      createMediaStreamSource = node
      createAnalyser = () => ({ context: this })
      createGain = () => ({ ...node(), gain: param() })
      createOscillator = () => ({ ...node(), frequency: param(), start: () => undefined })
      createScriptProcessor = () => {
        const processor = { ...node(), onaudioprocess: null as ((event: unknown) => void) | null }
        capture = processor
        return processor
      }
      decodeAudioData = async () => ({ duration: 1 })
      createBufferSource = () => {
        const source = Object.assign(new EventTarget(), node(), { start: () => undefined, stop })
        playback.push(source)
        return source
      }
      resume = async () => undefined
      close = async () => {
        this.state = 'closed'
      }
    },
  )
  harness.action.mockImplementation(async (ref) => {
    if (ref.name === 'startLocal') return { conversation: parseConversationId(22) }
    if (ref.name === 'sttWarm') return { ms: 1 }
    if (ref.name === 'transcribe')
      return { text: 'Can you start a coordinator that', speech: true, complete: false, ms: 1 }
    if (ref.name === 'heard') return {}
    if (ref.name === 'render') return { audio: btoa('audio'), mimeType: 'audio/wav' }
    if (ref.name === 'end') return {}
    throw new Error(`Unexpected action ${ref.name}`)
  })
  live.rememberStatus({ available: true, engine: 'local' })
  const container = renderSolid(() => (
    <p>
      {live.mode().engine} · {live.mode().phase}
    </p>
  ))
  await live.start()
  flush()
  expect(container.textContent).toBe('local · live')
  expect(getUserMedia).toHaveBeenCalledOnce()
  const frame = (level: number) =>
    capture!.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(2048).fill(level) },
    })
  frame(0.1)
  vi.setSystemTime(1100)
  frame(0)
  vi.setSystemTime(1499)
  frame(0)
  expect(harness.action.mock.calls.some(([ref]) => ref.name === 'transcribe')).toBe(false)
  vi.setSystemTime(1500)
  frame(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(harness.action.mock.calls.find(([ref]) => ref.name === 'transcribe')?.[1]).toMatchObject({
    turn: false,
    pcm: expect.any(String),
  })
  expect(harness.action.mock.calls.find(([ref]) => ref.name === 'heard')?.[1]).toEqual({
    text: 'Can you start a coordinator that',
  })
  live.hear('Ready.', 42)
  await vi.advanceTimersByTimeAsync(0)
  expect(playback).toHaveLength(1)
  live.stopSpeaking()
  expect(stop).toHaveBeenCalledOnce()
  expect(live.voiceMode().speaking).toBeUndefined()
  live.end()
  await vi.advanceTimersByTimeAsync(0)
  expect(track.stop).toHaveBeenCalledOnce()
  expect(harness.action.mock.calls.filter(([ref]) => ref.name === 'end')).toHaveLength(1)
})
