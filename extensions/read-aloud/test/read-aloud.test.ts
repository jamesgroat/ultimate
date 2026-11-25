import { afterEach, expect, it, vi } from 'vitest'
import { actions } from '../server.ts'
import { plainSpeech, sections } from '../speech.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

type Render = (args: { text: string; engine: string }) => Promise<unknown>

async function context(rewrite: (input: string) => string, render?: Render) {
  const userHome = await temp()
  cleanup.push(userHome)
  const rendered: string[] = []
  const asked: string[] = []
  const resources = new Map<string, unknown>()
  const conversations = {
    summaryModel: async () => ({ provider: 'p', id: 'm', thinking: 'low' }),
    askSummaryModel: async (_models: unknown, _system: string, input: string) => {
      asked.push(input)
      return { provider: 'p', model: 'm', text: rewrite(input), stopReason: 'stop' }
    },
  }
  const host = {
    userHome,
    modelRuntime: {},
    need: () => conversations,
    extensions: () => (render ? [{ name: 'speak', enabled: true }] : []),
    invoke: async (name: string, action: string, args: { text: string; engine: string }) => {
      expect([name, action, args.engine]).toEqual(['speak', 'render', 'mlx'])
      rendered.push(args.text)
      return render!(args)
    },
    resource: <T>(name: string, create: () => T) => {
      if (!resources.has(name)) resources.set(name, create())
      return resources.get(name) as T
    },
  }
  return {
    asked,
    rendered,
    ctx: { host, signal: new AbortController().signal } as unknown as ActionContext,
  }
}

const message =
  'Landed as `95a6f16` (#654228). It changes only test config.\n\n- **Faster checks:** e2e runs on 8 workers.\n- **No retry wait:** a test skips the backoff.'

it('rewrites a section with the summary model, voices it locally with speak, and serves a replay from the cache', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  const { asked, rendered, ctx } = await context(
    (input) => `Spoken: ${plainSpeech(input)}`,
    async () => ({ audio: 'AAEC', mimeType: 'audio/mp4' }),
  )
  const first = await actions.speak({ text: message, section: 0 }, ctx)
  expect(first).toEqual({
    sections: sections(message).length,
    spoken: `Spoken: ${plainSpeech(sections(message)[0])}`,
    audio: 'AAEC',
    mimeType: 'audio/mp4',
  })
  expect(rendered).toEqual([first.spoken])
  expect(await actions.speak({ text: message, section: 0 }, ctx)).toEqual(first)
  expect([asked.length, rendered.length]).toEqual([1, 1])
  expect(fetch).not.toHaveBeenCalled()
})

it('reads the plain strip when the rewrite drops most of the text', async () => {
  const { rendered, ctx } = await context(
    () => 'A summary.',
    async () => ({ audio: 'AAEC', mimeType: 'audio/mp4' }),
  )
  const result = await actions.speak({ text: message, section: 0 }, ctx)
  expect(result.spoken).toBe(plainSpeech(sections(message)[0]))
  expect(rendered).toEqual([result.spoken])
})

it('stops waiting for a render that ignores cancellation, and caches nothing from it', async () => {
  let finish!: (value: unknown) => void
  const { rendered, ctx } = await context(
    (input) => plainSpeech(input),
    () => new Promise((resolve) => (finish = resolve)),
  )
  const controller = new AbortController()
  const pending = actions.speak(
    { text: message, section: 0 },
    { ...ctx, signal: controller.signal },
  )
  await vi.waitFor(() => expect(rendered).toHaveLength(1))
  controller.abort(new Error('stopped'))
  await expect(pending).rejects.toThrow('stopped')
  finish({ audio: 'AAEC', mimeType: 'audio/mp4' })
  const again = actions.speak({ text: message, section: 0 }, ctx)
  await vi.waitFor(() => expect(rendered).toHaveLength(2))
  finish({ audio: 'AQID', mimeType: 'audio/mp4' })
  expect((await again).audio).toBe('AQID')
})

it('fails plainly, with no paid or browser voice, where no local voice is available', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  const without = await context((input) => plainSpeech(input))
  await expect(actions.speak({ text: message, section: 0 }, without.ctx)).rejects.toThrow(
    'Read aloud needs the speak extension',
  )
  const broken = await context(
    (input) => plainSpeech(input),
    async () => {
      throw new Error('Open-model venv not found')
    },
  )
  await expect(actions.speak({ text: message, section: 0 }, broken.ctx)).rejects.toThrow(
    /needs the speak extension.*Open-model venv not found/,
  )
  expect(fetch).not.toHaveBeenCalled()
})

it('strips what does not work heard and keeps every point', () => {
  expect(plainSpeech(message)).toBe(
    'Landed as. It changes only test config.\n\nFaster checks: e2e runs on 8 workers. No retry wait: a test skips the backoff.',
  )
})
