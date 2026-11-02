import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { access, mkdir, open } from 'node:fs/promises'
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

/** The narrator owns its venv, models and socket; no other voice extension shares them. */
export function localPaths(userHome: string) {
  const root = join(userHome, '.local/share/ultimate-sounds')
  return {
    root,
    python: join(root, 'venv/bin/python'),
    socket: join(root, 'worker.sock'),
    log: join(root, 'worker.log'),
  }
}

export async function localAvailable(userHome: string) {
  try {
    await access(localPaths(userHome).python, constants.X_OK)
    return true
  } catch {
    // An absent or unusable venv leaves OpenAI and browser speech available.
    return false
  }
}

async function connect(path: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const socket = createConnection(path)
  try {
    await once(socket, 'connect', { signal })
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

function unavailable(error: unknown) {
  return ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')
}

async function start(userHome: string, ultimateRoot: string, idleMinutes: number) {
  const paths = localPaths(userHome)
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  const log = await open(paths.log, 'a', 0o600)
  try {
    // The worker takes worker.lock before imports or socket cleanup. Concurrent starters safely lose that lock.
    const child = spawn(
      paths.python,
      [
        join(ultimateRoot, 'extensions/sounds/narrator/worker.py'),
        '--idle-minutes',
        String(idleMinutes),
      ],
      {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: {
          ...process.env,
          HOME: userHome,
          HF_HOME: join(paths.root, 'models/huggingface'),
        },
      },
    )
    await once(child, 'spawn')
    child.unref()
    return child
  } finally {
    await log.close()
  }
}

type Rendered = {
  id: string
  ok: boolean
  error?: string
  audio?: string
  sampleRate?: number
  provider?: string
  ms?: number
}

async function render(
  socket: Socket,
  text: string,
  voice: string,
  speed: number,
  signal: AbortSignal,
) {
  const id = randomUUID()
  let cancel: () => void = () => {}
  try {
    return await new Promise<Rendered>((resolve, reject) => {
      cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) return cancel()
      socket.once('error', reject)
      socket.once('close', () => reject(new Error('Local narrator disconnected')))
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        data += chunk
        const end = data.indexOf('\n')
        if (end < 0) return
        try {
          const response: Rendered = JSON.parse(data.slice(0, end))
          if (response.id !== id) throw new Error('Unexpected local narrator response')
          resolve(response)
        } catch (error) {
          reject(error)
        }
      })
      socket.write(JSON.stringify({ id, op: 'render', text, voice, speed }) + '\n')
    })
  } finally {
    signal.removeEventListener('abort', cancel)
    socket.destroy()
  }
}

/** Render one line through the machine-local daemon; only raw 24 kHz mono PCM16 LE is accepted. */
export async function narrate(
  userHome: string,
  ultimateRoot: string,
  text: string,
  voice: string,
  speed: number,
  idleMinutes: number,
  signal: AbortSignal,
) {
  if (!(await localAvailable(userHome))) return undefined
  const paths = localPaths(userHome)
  let socket: Socket
  try {
    socket = await connect(paths.socket, signal)
  } catch (error) {
    if (!unavailable(error)) throw error
    signal.throwIfAborted()
    const child = await start(userHome, ultimateRoot, idleMinutes)
    for (;;) {
      await pause(50, undefined, { signal })
      if ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null)
        throw new Error(`Local narrator exited: ${child.exitCode ?? child.signalCode}`, {
          cause: error,
        })
      try {
        socket = await connect(paths.socket, signal)
        break
      } catch (retryError) {
        if (!unavailable(retryError)) throw retryError
      }
    }
  }
  const result = await render(socket, text, voice, speed, signal)
  if (!result.ok) throw new Error(result.error ?? 'Local narrator failed')
  if (result.sampleRate !== 24000 || typeof result.audio !== 'string')
    throw new Error('Local narrator must return 24 kHz PCM16')
  const pcm = Buffer.from(result.audio, 'base64')
  if (!pcm.length || pcm.length % 2) throw new Error('Local narrator returned invalid PCM16')
  console.info(`[sounds] ${result.provider ?? 'local'} rendered in ${result.ms ?? '?'} ms`)
  return pcm
}
