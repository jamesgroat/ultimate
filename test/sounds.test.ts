import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import { actions } from '../extensions/sounds/server.ts'
import { localPaths } from '../extensions/sounds/local.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { temp } from './helpers.ts'

const pcm = Buffer.from([0, 0, 255, 127, 0, 128])
const servers: Server[] = []
const sockets = new Set<Socket>()
afterEach(async () => {
  vi.unstubAllGlobals()
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

function openai() {
  const connect = vi.fn<(url: string, protocols: string[]) => EventTarget>(function () {
    const socket = new EventTarget()
    Object.assign(socket, {
      close: vi.fn<() => void>(),
      send: (data: string) => {
        if (JSON.parse(data).type !== 'response.create') return
        for (const event of [
          { type: 'response.output_audio.delta', delta: pcm.toString('base64') },
          { type: 'response.done' },
        ])
          socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
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

it('defaults to OpenAI and leaves speech to the browser without a key', async () => {
  const { ctx, requests } = await fixture({ daemon: true })
  const connect = openai()
  expect(await actions.status(null, ctx)).toEqual({ voice: 'openai', localAvailable: true })
  expect(await actions.say({ text: 'Browser narrator fallback.' }, ctx)).toEqual({ audio: null })
  expect(requests).toHaveLength(0)
  expect(connect).not.toHaveBeenCalled()
})

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
