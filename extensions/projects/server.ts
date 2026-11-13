/**
 * Projects: the Ultimate instances running on this machine, from the host's project list (`host.projects()`), and those
 * the user names in `remotes` on other machines, each with its live counts from its own `status` action, for the rail's
 * project switcher.
 */
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { readJson, updateJson } from '../../lib/json-file.ts'
import { postAction, remotes } from '../../lib/remote.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { MessagesApi } from '../messages/api.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import type { Status as TailscaleStatus } from '../tailscale/refs.ts'
import { ListAction, PinAction } from './refs.ts'
import type { RunningProject } from './refs.ts'

/** How long the list waits for another instance's answers; a slower one shows as unavailable until the next poll. */
const STATUS_WAIT = 1_500

type Live = { available: boolean; busy?: number; questions?: number }

/** This instance's counts, as its own `status` action reports them. */
async function own(host: ExtensionHost): Promise<Live> {
  return {
    available: true,
    busy: host.conversations().filter((conversation) => conversation.busy).length,
    questions: (await host.need(MessagesApi).openQuestions(context)).length,
  }
}

/** `extension/action` on another instance, or nothing when it does not answer in time. */
const ask = (label: string, url: string, extension: string, signal: AbortSignal) =>
  postAction(
    // A configured URL may end in a slash; postAction appends `/api/...` to it.
    { url: url.replace(/\/+$/, ''), label },
    extension,
    'status',
    null,
    AbortSignal.any([signal, AbortSignal.timeout(STATUS_WAIT)]),
  ).catch(() => {
    // Down, slow or without that extension: the rail shows it without what it would have said.
    return undefined
  })

/** Another instance's counts from its `status` action; unavailable when it does not answer in time. */
async function counts(label: string, url: string, signal: AbortSignal): Promise<Live> {
  const status = (await ask(label, url, 'status', signal)) as
    | { busy?: unknown; questions?: { count?: unknown } }
    | undefined
  const busy = status?.busy
  const questions = status?.questions?.count
  return typeof busy === 'number' && typeof questions === 'number'
    ? { available: true, busy, questions }
    : { available: false }
}

/** The Tailscale URL an instance on this machine advertises while published, from its own `tailscale/status`. */
async function advertised(label: string, url: string, signal: AbortSignal) {
  const status = (await ask(label, url, 'tailscale', signal)) as
    | Partial<TailscaleStatus>
    | undefined
  return status?.state === 'ready' && typeof status.url === 'string' ? status.url : undefined
}

/**
 * Every instance running on this machine (`host.projects()`), then each one the user names in `remotes` on another
 * machine, with the full Tailscale URL a local one advertises and the live counts each reports.
 */
export async function list(host: ExtensionHost, signal: AbortSignal): Promise<RunningProject[]> {
  const local = (await host.projects()).flatMap(({ name, running, current }) => {
    // This server answers whether or not a supervisor wrote its port into the lock (a preview's has none).
    const url = current ? host.system().process.url : running?.url
    if (!url) return []
    return [
      (async (): Promise<RunningProject> => {
        if (current) {
          const status = host.want(TailscaleApi)?.status()
          const tailnet = status?.state === 'ready' ? status.url : undefined
          return { name, url, ...(tailnet && { tailnet }), current, ...(await own(host)) }
        }
        const [live, tailnet] = await Promise.all([
          counts(name, url, signal),
          advertised(name, url, signal),
        ])
        return { name, url, ...(tailnet && { tailnet }), current, ...live }
      })(),
    ]
  })
  const others = (await remotes(host)).map(
    async ({ machine, name, url }): Promise<RunningProject> => ({
      name,
      machine,
      url,
      current: false,
      ...(await counts(`${name} on ${machine}`, url, signal)),
    }),
  )
  return Promise.all([...local, ...others])
}

/** The rail's pin, one file for every instance on this machine, so jumping keeps the rail as it was. */
const pinPath = (host: ExtensionHost) => join(host.userHome, '.ultimate', 'projects-rail.json')
const readPin = async (path: string) => {
  const value = await readJson<{ pinned?: unknown }>(path, {})
  return { pinned: value.pinned === true }
}

export default function projects(host: ExtensionHost) {
  // Resolved where it is called; declared here so the catalogue lists it.
  host.need(MessagesApi)
  host.want(TailscaleApi)
  return defineExtension({ name: 'projects' })
}

/** The rail polls both: the trace counts their repeats instead of writing each. */
export const pollActions = ['list', 'pin']

export const actions = {
  list: implementAction(ListAction, (_args, { host, signal }) => list(host, signal)),
  pin: implementAction(PinAction, async (args, { host }) => {
    const pinned =
      args && typeof args === 'object' && !Array.isArray(args) ? args.pinned : undefined
    if (pinned !== undefined && typeof pinned !== 'boolean')
      throw new Error('pinned must be a boolean')
    const path = pinPath(host)
    if (pinned !== undefined)
      await updateJson(path, readPin, (value) => {
        value.pinned = pinned
      })
    return readPin(path)
  }),
}
