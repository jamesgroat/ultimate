import { createEffect, createRoot, createSignal } from 'solid-js'
import { api, errorMessage, ROOT, useUiState } from '@/sdk/solid'
import { animationFrames } from '../../lib/timers.ts'
import { cell } from '../../lib/cell.ts'
import { inProcess, overshadowed } from '../../lib/errors.ts'
import { SpeakAction } from './refs.ts'
import type { OpenAiVoice } from './refs.ts'
import { createPlayer, fetchedVoice, systemVoice, systemVoices } from './speech.ts'
import type { Sentence } from './speech.ts'
import { VOICES } from './voices.ts'

export const BLOCKED = 'Tap ▶ to let this page play sound'

export const speech = createRoot(() => {
  const [voice, setVoice] = useUiState<'system' | 'openai' | 'local'>(
    'ext.read-aloud.voice',
    'local',
  )
  const [storedVoice, setOpenaiVoice] = useUiState('ext.read-aloud.openai-voice', 'cedar')
  const openaiVoice = (): OpenAiVoice => {
    const stored = storedVoice()
    return VOICES.find((known) => known === stored) ?? 'cedar'
  }
  const [rate, setRate] = useUiState('ext.read-aloud.rate', 1.1)
  const [keyed, setKeyed] = createSignal<boolean | undefined>()
  const [local, setLocal] = createSignal(false)
  const failure = cell<{ key?: string; message: string } | undefined>(undefined)
  const voices = systemVoices()
  const [voiced, setVoiced] = createSignal(voices.some())
  voices.subscribe(() => setVoiced(voices.some()))
  const localOn = () => voice() === 'local' && local()
  const openaiOn = () => !localOn() && keyed() === true && (voice() !== 'system' || !voiced())
  const fetched = (source: 'local' | 'openai') =>
    fetchedVoice({
      load: async (text, signal) => {
        const { audio, mimeType } = await api.action(
          SpeakAction,
          { voice: source === 'local' ? 'local' : openaiVoice(), text },
          { conversationId: ROOT, signal },
        )
        return `data:${mimeType ?? 'audio/wav'};base64,${audio}`
      },
      audio: new Audio(),
      failed: (error) => {
        failure.set({ key: player.state.get().key, message: `Speech: ${errorMessage(error)}` })
        player.stop()
      },
    })
  const openai = fetched('openai')
  const localVoice = fetched('local')
  const system = systemVoice()
  let holding = () => false
  const player = createPlayer({
    rate,
    enabled: () => true,
    listening: () => holding(),
    frame: animationFrames,
    engine: () => (localOn() ? localVoice : openaiOn() ? openai : system),
  })
  createEffect(
    () => (localOn() ? 'local' : openaiOn() ? 'openai' : 'system'),
    () => player.switched(),
  )
  for (const type of ['pointerdown', 'pointerup', 'keydown'] as const)
    addEventListener(
      type,
      () => {
        openai.unlock?.()
        localVoice.unlock?.()
        system.unlock?.()
      },
      { capture: true },
    )
  return {
    ...player,
    load(
      key: string,
      sentences: readonly Sentence[],
      streaming: boolean,
      hold: () => boolean = () => false,
    ) {
      failure.set(undefined)
      holding = hold
      player.load(key, sentences, streaming)
    },
    failure,
    voice,
    setVoice,
    openaiVoice,
    setOpenaiVoice,
    rate,
    setRate,
    keyed,
    setKeyed,
    voiced,
    openaiOn,
    localOn,
    local,
    setLocal,
    warm() {
      if (!openaiOn()) return
      inProcess(
        'opening the voice connection early only saves this page time',
        api
          .action(SpeakAction, { voice: openaiVoice() }, { conversationId: ROOT })
          .catch(overshadowed),
      )
    },
  }
})

export type Speech = typeof speech
