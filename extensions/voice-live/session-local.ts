import { ignoring, inProcess, keepLast } from '../../lib/errors.ts'
import { actionRef } from '../../shared/extension-api.ts'
import { EndAction, HeardAction, StartLocalAction } from './refs.ts'
import type { LiveOptions, LiveSession } from './session.ts'

type Transcript = { text: string; speech: boolean; complete?: boolean; ms: number }
const TranscribeAction = actionRef<{ pcm: string; turn?: boolean }, Transcript>(
  'speak',
  'transcribe',
)
const WarmAction = actionRef<null, { ms: number }>('speak', 'sttWarm')
const RenderAction = actionRef<
  { text: string; voice: string; rate?: number; engine: 'mlx'; model: string },
  { audio: string; mimeType: string }
>('speak', 'render')

const RATE = 16_000
export const CUT_MS = 400
export const HOLD_MS = 1600
const PARTIAL_MS = 1000
const PREROLL_MS = 300
const ECHO_TAIL_MS = 350
const MAX_MS = 30_000

export function sentences(text: string) {
  return (text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) ?? [text])
    .map((part) => part.trim())
    .filter(Boolean)
}

function toPcm(chunks: Float32Array[], from: number) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  const ratio = from / RATE
  const out = new Int16Array(Math.floor(total / ratio))
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio
    const low = Math.floor(at)
    const high = Math.min(low + 1, total - 1)
    const sample = joined[low] + (joined[high] - joined[low]) * (at - low)
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)))
  }
  const bytes = new Uint8Array(out.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function voiceOf() {
  const rate = Number(localStorage.getItem('speak:rate'))
  return {
    engine: 'mlx' as const,
    model: localStorage.getItem('speak:mlx-model') || 'mlx-community/Kokoro-82M-bf16',
    voice: localStorage.getItem('speak:mlx-voice') || 'af_heart',
    ...(rate >= 0.5 && rate <= 3 ? { rate } : {}),
  }
}

export async function startLocal(
  options: LiveOptions & {
    onLine?: () => void
  },
): Promise<LiveSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const audioContext = new AudioContext()
  const source = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()
  source.connect(analyser)
  const capture = audioContext.createScriptProcessor(2048, 1, 1)
  const sink = audioContext.createGain()
  sink.gain.value = 0
  source.connect(capture)
  capture.connect(sink).connect(audioContext.destination)
  const frameMs = (2048 / audioContext.sampleRate) * 1000
  const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

  let conversation: number | undefined
  let releasing = false
  let muted = false
  let began = Date.now()
  let activityAt = Date.now()
  let heard: Float32Array[] = []
  let preroll: Float32Array[] = []
  let voicedAt = 0
  let quietSince = 0
  let words = ''
  let cut: 'none' | 'pending' | 'held' = 'none'
  let partialAt = 0
  let partialBusy = false
  let floor = 0.004
  let pending = Promise.resolve()
  let playing: AudioBufferSourceNode | undefined
  let queue: { audio: Promise<AudioBuffer | undefined>; words: number; first: boolean }[] = []
  let draining = false
  let talkingUntil = 0
  let spoken = 0
  let generation = 0

  const send = (text: string) => {
    pending = pending
      .then(async () => {
        await options.action(HeardAction, { text })
      })
      .catch((error: unknown) => options.onError(errorOf(error)))
  }
  const reset = () => {
    heard = []
    words = ''
    cut = 'none'
    voicedAt = 0
    quietSince = 0
  }
  const finish = (text: string) => {
    reset()
    if (!text) return
    options.onLine?.()
    send(text)
  }
  const transcribe = async (turn: boolean) =>
    options.action(TranscribeAction, { pcm: toPcm(heard, audioContext.sampleRate), turn })

  const cutNow = () => {
    cut = 'pending'
    const length = heard.length
    inProcess(
      'a voice turn belongs to the open browser page',
      transcribe(true)
        .then((result) => {
          if (releasing || cut !== 'pending') return
          if (heard.length !== length && voicedAt > quietSince) return void (cut = 'none')
          if (!result.speech) return reset()
          words = result.text
          if (result.complete !== false) finish(result.text)
          else cut = 'held'
        })
        .catch((error: unknown) => {
          reset()
          options.onError(errorOf(error))
        }),
    )
  }
  const partial = () => {
    partialBusy = true
    partialAt = Date.now()
    inProcess(
      'a partial transcript belongs to the open browser page',
      transcribe(false)
        .then((result) => {
          if (cut === 'none' && heard.length && result.speech) words = result.text
        })
        .catch(keepLast)
        .finally(() => (partialBusy = false)),
    )
  }

  capture.onaudioprocess = (event) => {
    if (releasing) return
    const now = Date.now()
    const input = new Float32Array(event.inputBuffer.getChannelData(0))
    if (muted || playing || now < talkingUntil) {
      preroll = []
      return
    }
    let sum = 0
    for (const sample of input) sum += sample * sample
    const level = Math.sqrt(sum / input.length)
    const voiced = level > Math.max(0.012, floor * 3)
    if (!voiced) floor = floor * 0.95 + level * 0.05
    if (!heard.length) {
      if (!voiced) {
        preroll.push(input)
        if (preroll.length * frameMs > PREROLL_MS) preroll.shift()
        return
      }
      heard = [...preroll, input]
      preroll = []
      voicedAt = now
      partialAt = now
      activityAt = now
      return
    }
    heard.push(input)
    if (voiced) {
      voicedAt = now
      activityAt = now
      quietSince = 0
      if (cut === 'held') cut = 'none'
    } else quietSince ||= now
    const quiet = quietSince ? now - quietSince : 0
    if (heard.length * frameMs > MAX_MS) cutNow()
    else if (cut === 'none' && quiet >= CUT_MS) cutNow()
    else if (cut === 'held' && quiet >= CUT_MS + HOLD_MS) finish(words)
    else if (cut === 'none' && !quiet && !partialBusy && now - partialAt >= PARTIAL_MS) partial()
  }

  const render = (text: string, run: number) =>
    options.action(RenderAction, { ...voiceOf(), text }).then(async ({ audio }) => {
      if (run !== generation) return undefined
      const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0))
      return audioContext.decodeAudioData(bytes.buffer)
    })
  const drain = async (run: number) => {
    draining = true
    const current = () => run === generation
    try {
      while (current() && queue.length) {
        const next = queue[0]
        let buffer: AudioBuffer | undefined
        try {
          buffer = await next.audio
        } catch (error) {
          options.onError(errorOf(error))
        }
        if (run !== generation) return
        queue.shift()
        if (!buffer) continue
        const node = audioContext.createBufferSource()
        node.buffer = buffer
        node.connect(audioContext.destination)
        playing = node
        if (next.first) spoken = 0
        spoken += next.words
        activityAt = Date.now()
        await new Promise<void>((resolve) => {
          node.addEventListener('ended', () => resolve(), { once: true })
          node.start()
        })
        playing = undefined
      }
      talkingUntil = Date.now() + ECHO_TAIL_MS
      activityAt = Date.now()
    } finally {
      if (run === generation) draining = false
    }
  }
  const stopSpeaking = () => {
    generation++
    draining = false
    queue = []
    const node = playing
    playing = undefined
    try {
      node?.stop()
    } catch (error) {
      ignoring((cause) => cause instanceof DOMException && cause.name === 'InvalidStateError')(
        error,
      )
    }
    talkingUntil = Date.now() + ECHO_TAIL_MS
  }
  const speak = (text: string) => {
    const run = generation
    for (const [index, part] of sentences(text).entries())
      queue.push({
        audio: render(part, run),
        words: part.split(/\s+/).filter(Boolean).length,
        first: index === 0,
      })
    talkingUntil = Number.POSITIVE_INFINITY
    reset()
    if (!draining)
      inProcess(
        'playback belongs to the open browser page',
        drain(run).catch((error: unknown) => options.onError(errorOf(error))),
      )
  }

  const cleanup = async () => {
    if (releasing) return
    releasing = true
    stopSpeaking()
    capture.onaudioprocess = null
    stream.getTracks().forEach((track) => track.stop())
    await audioContext.close()
  }
  let closePromise: Promise<void> | undefined
  const close = () =>
    (closePromise ??= (async () => {
      await cleanup()
      await pending
      if (conversation !== undefined)
        await options.action(EndAction, { seconds: Math.round((Date.now() - began) / 1000) })
    })())

  try {
    await audioContext.resume()
    const [started] = await Promise.all([
      options.action(StartLocalAction, null),
      options.action(WarmAction, null),
    ])
    conversation = started.conversation
    began = Date.now()
    activityAt = began
    return {
      conversation,
      analyser,
      relay: {
        hearing: () => heard.length > 0,
        talking: () => playing !== undefined || queue.length > 0,
        partial: () => (heard.length ? words : ''),
        spokenWords: () => spoken,
        idleFor: (now) => Math.max(0, now - activityAt),
      },
      send: () => undefined,
      mute: () => {
        muted = true
        reset()
      },
      unmute: () => {
        muted = false
      },
      speak,
      stopSpeaking,
      close,
    }
  } catch (error) {
    if (conversation !== undefined)
      await close().catch((cause: unknown) => options.onError(errorOf(cause)))
    else await cleanup()
    throw error
  }
}
