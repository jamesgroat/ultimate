import diagnostics from 'node:diagnostics_channel'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import { actions } from '../server.ts'
import { localPaths } from '../local.ts'
import * as local from '../local.ts'
import type { Line } from '../narration.ts'
import { speaker } from '../speaker.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { temp } from '../../../test/helpers.ts'

const pcm = Buffer.from([0, 0, 255, 127, 0, 128])
const servers: Server[] = []
const sockets = new Set<Socket>()
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const socket of sockets) socket.destroy()
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  )
})

type Request = { id: string; op: string; text: string; voice: string; speed: number }
async function fixture(options: { daemon?: boolean; key?: string; project?: JsonObject } = {}) {
  // Keep Unix socket paths below macOS's 104-byte limit, independent of the test launcher's TMPDIR length.
  const home = await temp('sounds-', '/tmp')
  await mkdir(`${home}/.ultimate`)
  await writeFile(
    `${home}/.ultimate/settings.json`,
    JSON.stringify({ sounds: { narratorVoice: 'af_heart', narratorRate: 1.25 } }),
  )
  const project: JsonObject = options.project ?? {}
  const requests: Request[] = []
  const daemon = { error: undefined as string | undefined }
  if (options.daemon) {
    const paths = localPaths(home)
    await mkdir(dirname(paths.python), { recursive: true })
    await symlink(process.execPath, paths.python)
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        data += chunk
        if (!data.includes('\n')) return
        const request: Request = JSON.parse(data)
        requests.push(request)
        socket.write(
          JSON.stringify({
            id: request.id,
            ...(daemon.error
              ? { ok: false, error: daemon.error }
              : {
                  ok: true,
                  audio: pcm.toString('base64'),
                  sampleRate: 24000,
                  provider: 'fake-local',
                  ms: 2,
                }),
          }) + '\n',
        )
      })
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(paths.socket, done))
  }
  const getAuth = vi.fn<() => Promise<{ auth: { apiKey: string | undefined } }>>(async () => ({
    auth: { apiKey: options.key },
  }))
  const host = {
    userHome: home,
    ultimateRoot: resolve('.'),
    projectSettings: async () => ({ sounds: project }),
    modelRuntime: {
      getProviderAuthStatus: () => ({ configured: !!options.key }),
      isUsingOAuth: () => false,
      getAuth,
    },
  } as unknown as ExtensionHost
  const ctx = { host, signal: new AbortController().signal } as ActionContext
  return { ctx, home, project, requests, daemon, getAuth }
}

function openai(onResponse: (respond: () => void) => void = (respond) => respond()) {
  const connect = vi.fn<(url: string, protocols: string[]) => EventTarget>(function () {
    const socket = new EventTarget()
    Object.assign(socket, {
      close: vi.fn<() => void>(() => socket.dispatchEvent(new Event('close'))),
      send: (data: string) => {
        if (JSON.parse(data).type !== 'response.create') return
        onResponse(() => {
          for (const event of [
            { type: 'response.output_audio.delta', delta: pcm.toString('base64') },
            { type: 'response.done' },
          ])
            socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
        })
      },
    })
    queueMicrotask(() => socket.dispatchEvent(new Event('open')))
    return socket
  })
  vi.stubGlobal('WebSocket', connect)
  return connect
}

it('uses local PCM, merges settings and caches by source, voice and rate; off bypasses cache', async () => {
  const { ctx, project, requests, getAuth } = await fixture({
    daemon: true,
    key: 'test-key',
    project: { voice: 'local', narratorRate: 1.5 },
  })
  const connect = openai()
  const text = 'Local narrator cache configuration.'
  const say = () => actions.say({ text }, ctx)
  expect(await say()).toEqual({ audio: pcm.toString('base64') })
  expect(requests).toEqual([
    expect.objectContaining({ op: 'render', text, voice: 'af_heart', speed: 1.5 }),
  ])
  expect(await say()).toEqual({ audio: pcm.toString('base64') })
  expect(requests).toHaveLength(1)
  expect(getAuth).not.toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()

  project.narratorVoice = 'bf_emma'
  await say()
  expect(requests[1]).toMatchObject({ voice: 'bf_emma', speed: 1.5 })
  project.narratorRate = 0.8
  await say()
  expect(requests[2]).toMatchObject({ voice: 'bf_emma', speed: 0.8 })
  project.voice = 'openai'
  await say()
  expect(connect).toHaveBeenCalledTimes(1)
  project.voice = 'off'
  expect(await say()).toEqual({ audio: null })
  project.voice = 'openai'
  await say()
  expect(connect).toHaveBeenCalledTimes(1)
  expect(requests).toHaveLength(3)
})

it.each(['missing', 'error'] as const)('falls back to OpenAI when local is %s', async (mode) => {
  const { ctx, daemon, getAuth } = await fixture({
    daemon: mode === 'error',
    key: 'test-key',
    project: { voice: 'local' },
  })
  daemon.error = 'Local model unavailable'
  const connect = openai()
  expect(await actions.say({ text: `Local fallback: ${mode}.` }, ctx)).toEqual({
    audio: pcm.toString('base64'),
  })
  expect(getAuth).toHaveBeenCalledTimes(1)
  expect(connect).toHaveBeenCalledWith(expect.stringContaining('wss://api.openai.com/'), [
    'realtime',
    'openai-insecure-api-key.test-key',
  ])
})

it('retries local after OpenAI fallback instead of caching fallback as local', async () => {
  const { ctx, daemon, requests } = await fixture({
    daemon: true,
    key: 'test-key',
    project: { voice: 'local' },
  })
  const connect = openai()
  const text = 'Retry the recovered local narrator.'
  daemon.error = 'Local model unavailable'
  expect(await actions.say({ text }, ctx)).toEqual({ audio: pcm.toString('base64') })
  expect(connect).toHaveBeenCalledTimes(1)
  daemon.error = undefined
  expect(await actions.say({ text }, ctx)).toEqual({ audio: pcm.toString('base64') })
  expect(await actions.say({ text }, ctx)).toEqual({ audio: pcm.toString('base64') })
  expect(requests).toHaveLength(2)
  expect(connect).toHaveBeenCalledTimes(1)
})

it('keeps OpenAI transport diagnostics when falling back to browser speech', async () => {
  const { ctx } = await fixture({ key: 'test-key' })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('WebSocket', function () {
    const socket = new EventTarget()
    Object.assign(socket, { close: () => socket.dispatchEvent(new Event('close')) })
    queueMicrotask(() => {
      diagnostics.channel('undici:request:headers').publish({
        request: { origin: 'https://api.openai.com', path: '/v1/realtime?model=test' },
        response: { statusCode: 503 },
      })
      socket.dispatchEvent(new Event('error'))
    })
    return socket
  })
  expect(await actions.say({ text: 'Preserve the failed handshake status.' }, ctx)).toEqual({
    audio: null,
  })
  expect(warning).toHaveBeenCalledWith(
    'Narrator voice failed',
    expect.objectContaining({ message: 'Could not reach OpenAI realtime: HTTP 503' }),
  )
})

it('defaults to OpenAI and leaves speech to the browser without a key', async () => {
  const { ctx, requests } = await fixture({ daemon: true })
  const connect = openai()
  expect(await actions.status(null, ctx)).toEqual({ voice: 'openai', localAvailable: true })
  expect(await actions.say({ text: 'Browser narrator fallback.' }, ctx)).toEqual({ audio: null })
  expect(requests).toHaveLength(0)
  expect(connect).not.toHaveBeenCalled()
})

it.each(['local', 'openai'] as const)(
  'resumes a cancelled %s line after a bundle switch and drains later cues only after playback',
  async (voice) => {
    const { ctx } = await fixture({ key: 'test-key', project: { voice } })
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const started = Promise.withResolvers<void>()
    const narrate = vi.spyOn(local, 'narrate').mockResolvedValue(pcm)
    if (voice === 'local')
      narrate.mockImplementationOnce(
        async (_home, _root, _text, _voice, _rate, _idle, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            started.resolve()
          }),
      )
    let first = true
    const connect = openai((respond) => {
      if (first) {
        first = false
        started.resolve()
      } else respond()
    })
    const session = new Map<string, string>()
    const drained = Promise.withResolvers<void>()
    const storage = {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => {
        session.set(key, value)
        if (value === '[]') drained.resolve()
      },
    }
    const landed = {
      key: `landed:${voice}`,
      sound: 'landed' as const,
      subject: `${voice} recovery`,
    }
    const controller = new AbortController()
    const cancelled = Promise.withResolvers<void>()
    speaker(async (line) => {
      try {
        await actions.say({ text: line.text! }, { ...ctx, signal: controller.signal })
      } finally {
        cancelled.resolve()
      }
    }, storage).add([landed])
    await vi.advanceTimersByTimeAsync(1500)
    await started.promise
    controller.abort(new Error('Page switched'))
    await cancelled.promise
    expect(JSON.parse([...session.values()][0])).toEqual([landed])

    // The new bundle uses the same backend, but keeps the cue until its audio has actually finished playing.
    if (voice === 'openai') openai()
    const rendered = Promise.withResolvers<void>()
    const playback = Promise.withResolvers<void>()
    const heard: Line[] = []
    const say = async (line: Line) => {
      const result = await actions.say({ text: line.text! }, ctx)
      expect(result).toEqual({ audio: pcm.toString('base64') })
      heard.push(line)
      if (heard.length === 1) {
        rendered.resolve()
        await playback.promise
      }
    }
    const resumed = speaker(say, storage)
    resumed.resume(true)
    await vi.advanceTimersByTimeAsync(1500)
    await rendered.promise
    expect(JSON.parse([...session.values()][0])).toEqual([landed])
    const question = { key: `question:${voice}`, sound: 'input' as const }
    resumed.add([question])
    expect(heard).toHaveLength(1)
    playback.resolve()
    await vi.advanceTimersByTimeAsync(1500)
    await drained.promise
    expect(heard).toEqual([
      { sound: 'landed', text: `Landed: ${voice} recovery.` },
      { sound: 'input', text: 'Ultimate has a question.' },
    ])
    expect(JSON.parse([...session.values()][0])).toEqual([])
    speaker(say, storage).resume(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(heard).toHaveLength(2)
    expect(narrate).toHaveBeenCalledTimes(voice === 'local' ? 3 : 0)
    expect(connect).toHaveBeenCalledTimes(voice === 'local' ? 0 : 1)
  },
)

it('shows a setup hint only when local is selected and its venv is missing', async () => {
  const { ctx, project } = await fixture({ project: { voice: 'local' } })
  expect(await actions.status(null, ctx)).toEqual({
    voice: 'local',
    localAvailable: false,
    hint: 'Set up local voice · see Sounds README',
  })
  project.voice = 'off'
  expect(await actions.status(null, ctx)).toEqual({ voice: 'off', localAvailable: false })
})
