import { createEffect, createRoot, createSignal, untrack } from 'solid-js'
import { api, errorMessage, ROOT, useUiState } from '@/sdk/solid'
import { animationFrames, deadline, pace } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { cell } from '../../lib/cell.ts'
import { inProcess, overshadowed } from '../../lib/errors.ts'
import { SpeakAction, SpeechStatusAction } from './refs.ts'
import type { OpenAiVoice } from './refs.ts'
import { createPlayer, fetchedVoice, systemVoice, systemVoices } from './speech.ts'
import type { Sentence } from './speech.ts'
import { VOICES } from './voices.ts'

export const BLOCKED = 'Tap ▶ to let this page play sound'
export const VOICE_UNAVAILABLE = 'Voice unavailable'
export const LOCAL_WAIT_SECONDS = 25
const LOADING_AFTER_MS = 1200

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
  const [local, setLocalSeen] = createSignal(false)
  const setLocal = (ready: boolean) => setLocalSeen((seen) => seen || ready)
  const failure = cell<{ key?: string; message: string } | undefined>(undefined)
  const voices = systemVoices()
  const [voiced, setVoiced] = createSignal(voices.some())
  voices.subscribe(() => setVoiced(voices.some()))
  const localOn = () => voice() === 'local' && local()
  const openaiOn = () => !localOn() && keyed() === true && (voice() !== 'system' || !voiced())
  const fetched = (source: 'local' | 'openai') =>
    fetchedVoice({
      load: async (text, signal) => {
        if (source === 'openai') {
          const { audio, mimeType } = await api.action(
            SpeakAction,
            { voice: openaiVoice(), text },
            { conversationId: ROOT, signal },
          )
          return `data:${mimeType ?? 'audio/wav'};base64,${audio}`
        }
        const giveUp = AbortSignal.any([signal, AbortSignal.timeout(LOCAL_WAIT_SECONDS * 1000)])
        for (;;) {
          try {
            const { audio, mimeType } = await api.action(
              SpeakAction,
              { voice: 'local', text },
              { conversationId: ROOT, signal: giveUp },
            )
            return `data:${mimeType ?? 'audio/wav'};base64,${audio}`
          } catch (error) {
            signal.throwIfAborted()
            if (giveUp.aborted)
              throw new Error(`Kokoro did not answer within ${LOCAL_WAIT_SECONDS} s`, {
                cause: error,
              })
            await pace(1000, giveUp).catch(overshadowed)
            if (giveUp.aborted) throw error
          }
        }
      },
      audio: new Audio(),
      failed: (error) => {
        const message =
          source === 'local'
            ? `${VOICE_UNAVAILABLE}: ${errorMessage(error)}`
            : `Speech: ${errorMessage(error)}`
        failure.set({ key: player.state.get().key, message })
        if (!player.pause()) player.stop()
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
  const [loadingVoice, setLoadingVoice] = createSignal(false)
  let loadingTimer: Cancel | undefined
  player.state.subscribe(() => {
    const { playing, audible } = player.state.get()
    const waiting = playing && !audible
    if (!waiting) {
      loadingTimer?.()
      loadingTimer = undefined
      setLoadingVoice(false)
    } else
      loadingTimer ??= deadline(LOADING_AFTER_MS, () =>
        setLoadingVoice(untrack(() => localOn() || openaiOn())),
      )
  })
  let asked = 0
  const refresh = () => {
    const mine = ++asked
    inProcess(
      'speech sources are asked again on the next refresh',
      api
        .action(SpeechStatusAction, null, { conversationId: ROOT })
        .then((known) => {
          if (mine !== asked) return
          setKeyed(known.openai)
          setLocal(known.local)
        })
        .catch(overshadowed),
    )
  }
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
    resume() {
      failure.set(undefined)
      player.resume()
    },
    failure,
    loadingVoice,
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
    refresh,
    warm() {
      if (!openaiOn() && !localOn()) return
      inProcess(
        'warming a voice early only saves this page time',
        api
          .action(
            SpeakAction,
            { voice: localOn() ? 'local' : openaiVoice() },
            { conversationId: ROOT },
          )
          .catch(overshadowed),
      )
    },
  }
})

export type Speech = typeof speech
