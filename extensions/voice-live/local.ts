import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exec } from '../../lib/exec.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

export async function localTranscript(
  host: ExtensionHost,
  recording: { data: string; mimeType: string },
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  if (!/^audio\/(webm|mp4|ogg)(;|$)/.test(recording.mimeType))
    throw new Error(`Unsupported local recording type: ${recording.mimeType}`)
  const dir = await mkdtemp(join(tmpdir(), 'voice-pcm-'))
  try {
    const input = join(dir, 'recording')
    const output = join(dir, 'mono.pcm')
    await writeFile(input, Buffer.from(recording.data, 'base64'))
    await exec(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        input,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        's16le',
        output,
      ],
      { signal, timeout: 30_000 },
    )
    const pcm = (await readFile(output)).toString('base64')
    signal.throwIfAborted()
    const answer = await host.invoke('speak', 'transcribe', { pcm, turn: false }, signal)
    signal.throwIfAborted()
    const text = (answer as { text?: unknown } | null)?.text
    if (typeof text !== 'string') throw new Error('Local transcription returned no text')
    return text.trim()
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(
      `Local Parakeet transcription failed (speak and ffmpeg required): ${String(error)}`,
      { cause: error },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function localSpeech(host: ExtensionHost, text: string, signal: AbortSignal) {
  signal.throwIfAborted()
  try {
    const result = await host.invoke('speak', 'render', { text, engine: 'mlx' }, signal)
    signal.throwIfAborted()
    const { audio, mimeType } = (result ?? {}) as { audio?: unknown; mimeType?: unknown }
    if (
      typeof audio !== 'string' ||
      !audio ||
      typeof mimeType !== 'string' ||
      !mimeType.startsWith('audio/')
    )
      throw new Error('Local Kokoro returned no audio')
    return { audio, mimeType }
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`Local Kokoro rendering failed (speak required): ${String(error)}`, {
      cause: error,
    })
  }
}
