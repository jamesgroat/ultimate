import type { ExtensionHost } from '../../server/extensions.ts'

export async function localSpeechReady(host: ExtensionHost, signal: AbortSignal) {
  if (!host.extensions().some((extension) => extension.name === 'speak' && extension.enabled))
    return false
  try {
    const prefs = (await host.invoke('speak', 'prefs', null, signal)) as {
      source?: string
      model?: string
    }
    if (prefs.source !== 'mlx') return false
    const status = (await host.invoke(
      'speak',
      'mlxStatus',
      prefs.model ? { model: prefs.model } : {},
      signal,
    )) as {
      ready?: boolean
    }
    return status.ready === true
  } catch (error) {
    signal.throwIfAborted()
    console.warn('Local speech unavailable', error)
    return false
  }
}

export async function localSpeech(host: ExtensionHost, text: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const result = await host.invoke('speak', 'render', { text, engine: 'mlx' }, signal)
  signal.throwIfAborted()
  const { audio, mimeType } = (result ?? {}) as { audio?: unknown; mimeType?: unknown }
  if (
    typeof audio !== 'string' ||
    !audio ||
    typeof mimeType !== 'string' ||
    !mimeType.startsWith('audio/')
  )
    throw new Error('Local speech returned no audio')
  return { audio, mimeType }
}

export async function warmLocalSpeech(host: ExtensionHost, signal: AbortSignal) {
  const prefs = (await host.invoke('speak', 'prefs', null, signal)) as { model?: string }
  await host.invoke('speak', 'mlxWarm', prefs.model ? { model: prefs.model } : {}, signal)
}
