import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exec } from '../../lib/exec.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

export async function localTranscriptionReady(host: ExtensionHost, signal: AbortSignal) {
  if (!host.extensions().some((extension) => extension.name === 'speak' && extension.enabled))
    return false
  try {
    const status = (await host.invoke('speak', 'sttStatus', null, signal)) as { ready?: boolean }
    return status.ready === true
  } catch (error) {
    signal.throwIfAborted()
    console.warn('Local transcription unavailable', error)
    return false
  }
}

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
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
