import { expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { localSpeechReady } from '../local.ts'
import { actions } from '../server.ts'
import type { ActionContext } from '../../../server/actions.ts'

it('renders through the configured local source with its MIME and rejects late audio after cancellation', async () => {
  const invoke = vi
    .fn<ExtensionHost['invoke']>()
    .mockResolvedValue({ audio: 'AQACAA==', mimeType: 'audio/mp4' })
  const controller = new AbortController()
  const ctx = { host: { invoke }, signal: controller.signal } as unknown as ActionContext
  expect(await actions.speak({ voice: 'local', text: 'Hello.' }, ctx)).toEqual({
    audio: 'AQACAA==',
    mimeType: 'audio/mp4',
  })
  expect(invoke).toHaveBeenCalledWith(
    'speak',
    'render',
    { text: 'Hello.', engine: 'mlx' },
    controller.signal,
  )
  invoke.mockResolvedValueOnce({ audio: 'AQACAA==', mimeType: 'text/plain' })
  await expect(actions.speak({ voice: 'local', text: 'Invalid.' }, ctx)).rejects.toThrow(
    'Local speech returned no audio',
  )
  const pending = Promise.withResolvers<unknown>()
  invoke.mockReturnValue(pending.promise)
  const late = actions.speak({ voice: 'local', text: 'Late.' }, ctx)
  controller.abort(new Error('stopped'))
  pending.resolve({ audio: 'late', mimeType: 'audio/mp4' })
  await expect(late).rejects.toThrow('stopped')
})

it('keeps STT readiness out of TTS capability and honors device speech preferences', async () => {
  const invoke = vi.fn<ExtensionHost['invoke']>().mockResolvedValue({ source: 'device' })
  const host = { extensions: () => [], invoke } as unknown as ExtensionHost
  expect(await localSpeechReady(host, new AbortController().signal)).toBe(false)
  expect(invoke).not.toHaveBeenCalled()
  host.extensions = vi
    .fn<ExtensionHost['extensions']>()
    .mockReturnValue([{ name: 'speak', enabled: true }] as ReturnType<ExtensionHost['extensions']>)
  expect(await localSpeechReady(host, new AbortController().signal)).toBe(false)
  expect(invoke).toHaveBeenCalledTimes(1)
  invoke
    .mockResolvedValueOnce({ source: 'mlx', model: 'configured/model' })
    .mockResolvedValueOnce({ ready: true })
  expect(await localSpeechReady(host, new AbortController().signal)).toBe(true)
  expect(invoke).toHaveBeenLastCalledWith(
    'speak',
    'mlxStatus',
    { model: 'configured/model' },
    expect.any(AbortSignal),
  )
})
