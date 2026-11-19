import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { DocumentWatch, JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { inProcess, settled } from '../../lib/errors.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { readHealth, record, reset } from './store.ts'
import { HealthApi } from './api.ts'
import type { ProviderReport } from './api.ts'
import { LoginChanged } from '../models/api.ts'
import { NoticesApi } from '../notices/api.ts'
import type { Flip, HealthEntry } from './store.ts'
import { Changed } from './refs.ts'
import { classifyFailure } from './failure.ts'
import { releaseClaim, noticeKey, noticeSlot, step, updateEpisodes } from './episodes.ts'
import type { EpisodeQueue, NoticeClass } from './episodes.ts'
import { noticeFor } from './notice.ts'

const ROUTING_STATE = 'subscription-routing.state'
type Reading = { exhausted?: boolean; resetsAt?: number | null }
type RoutingPair = {
  preferred?: { provider?: string }
  alternative?: { provider?: string }
  readings?: { preferred?: Reading; alternative?: Reading }
}

export function exhaustedProviders(state: unknown): Map<string, number | undefined> {
  const pairs = (state as { plan?: { pairs?: Record<string, RoutingPair> } } | undefined)?.plan
    ?.pairs
  const exhausted = new Map<string, number | undefined>()
  for (const pair of Object.values(pairs ?? {}))
    for (const side of ['preferred', 'alternative'] as const) {
      const provider = pair[side]?.provider
      const reading = pair.readings?.[side]
      if (!provider || !reading?.exhausted) continue
      const at = typeof reading.resetsAt === 'number' ? reading.resetsAt : undefined
      const earlier = exhausted.get(provider)
      exhausted.set(
        provider,
        earlier === undefined ? at : at === undefined ? earlier : Math.min(earlier, at),
      )
    }
  return exhausted
}

export type Notifier = {
  report(report: ProviderReport): Promise<void>
  routing(state: unknown): Promise<void>
}

export function notifier(options: {
  home: string
  queue: EpisodeQueue
  now: () => number
  post: (notice: {
    key: string
    slot: string
    tag: string
    title: string
    text: string
  }) => Promise<boolean>
  describe: (
    provider: string,
    cls: NoticeClass,
    resetsAt?: number,
  ) => Promise<{ title: string; text: string }>
}): Notifier {
  const open = async (
    provider: string,
    outcome: { ok: true } | { ok: false; class: ReturnType<typeof classifyFailure>['class'] },
    resetsAt?: number,
  ) => {
    const at = options.now()
    const unposted = await updateEpisodes(options.home, options.queue, (file) =>
      step(file, provider, outcome.ok ? outcome : { ...outcome, at }),
    )
    if (!unposted) return
    const delivered = await options
      .describe(provider, unposted.class, resetsAt)
      .then(({ title, text }) =>
        options.post({
          key: noticeKey(provider, unposted.class, unposted.since),
          slot: noticeSlot(provider),
          tag: 'Provider',
          title,
          text,
        }),
      )
      .catch((error: unknown) => {
        console.error('health: posting a provider notice failed:', error)
        return false
      })
    if (!delivered)
      await updateEpisodes(options.home, options.queue, (file) =>
        releaseClaim(file, provider, unposted),
      )
  }
  const logged = (work: Promise<unknown>) =>
    work.then(
      () => undefined,
      (error: unknown) => console.error('health: a provider notice failed:', error),
    )
  return {
    report: (report) => logged(reportOutcome(report)),
    routing: (state) => logged(readRouting(state)),
  }
  async function reportOutcome(report: ProviderReport) {
    if (report.ok) return open(report.provider, { ok: true })
    const failure = classifyFailure(
      { status: report.status, error: report.error ?? '' },
      options.now(),
    )
    await open(
      report.provider,
      { ok: false, class: failure.class },
      report.resetsAt ?? failure.resetsAt,
    )
  }
  async function readRouting(state: unknown) {
    const now = exhaustedProviders(state)
    const flipped = await updateEpisodes(options.home, options.queue, (file) => {
      const newly = [...now.keys()].filter((provider) => !file.exhausted[provider])
      file.exhausted = Object.fromEntries([...now.keys()].map((provider) => [provider, true]))
      return newly
    })
    for (const provider of flipped)
      await open(provider, { ok: false, class: 'usage' }, now.get(provider))
  }
}

export function responseEntry(message: AssistantMessage, now: number): HealthEntry | undefined {
  if (message.stopReason === 'aborted') return undefined
  if (message.stopReason === 'error')
    return { lastFail: now, error: message.errorMessage ?? 'error', lastUsed: now }
  return { lastOk: now, lastUsed: now }
}

function openHarness(host: Pick<ExtensionHost, 'harness'>) {
  try {
    return host.harness()
  } catch {
    return undefined
  }
}

export async function announce(host: Pick<ExtensionHost, 'harness' | 'emit'>, flips: Flip[]) {
  const changed = flips.filter((flip) => flip.from !== flip.to)
  if (!changed.length) return
  const harness = openHarness(host)
  if (!harness) return
  await harness
    .commit(async (tx) => {
      for (const { provider, to, error } of changed)
        await host.emit(tx, Changed, { provider, state: to, ...(error ? { error } : {}) })
    }, context)
    .catch((error: unknown) => console.error('health: announcing a change failed:', error))
}

export async function recordHealth(
  userHome: string,
  provider: string,
  entry: HealthEntry,
  announceHealthFlip: (flips: Flip[]) => Promise<void> = async () => {},
) {
  await announceHealthFlip([await record(userHome, provider, entry)])
}

async function agentsOn(host: ExtensionHost, provider: string) {
  const { definitions } = await discoverAgents(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  return definitions
    .filter((definition) => (definition.runs?.model ?? definition.model)?.provider === provider)
    .map((definition) => definition.name)
}

export default function health(host: ExtensionHost) {
  const announceHealthFlip = (flips: Flip[]) => announce(host, flips)
  const queue = host.resource<EpisodeQueue>('health.episodes', () => ({
    writes: Promise.resolve(),
  }))
  const notices = notifier({
    home: host.home,
    queue,
    now: Date.now,
    post: async (notice) => {
      const service = host.want(NoticesApi)
      if (!service) return false
      await service.post(notice)
      return true
    },
    describe: async (provider, cls, resetsAt) =>
      noticeFor({
        provider,
        name: host.modelRuntime.getProvider(provider)?.name ?? provider,
        class: cls,
        resetsAt,
        agents: await agentsOn(host, provider).catch(() => []),
      }),
  })
  let routing: DocumentWatch<JsonObject> | undefined
  let attaching: Promise<void> | undefined
  let released = true
  const attach = async () => {
    const token = host.doc(ROUTING_STATE)
    const watch = token
      ? await host.harness().watchDoc(token, ROOT_CONVERSATION_ID, context)
      : undefined
    if (!watch) return
    if (released) {
      await watch.stop()
      return
    }
    routing = watch
    await notices.routing(watch.value)
    watch.start(async (call) => {
      if (call.kind === 'value') await notices.routing(call.value)
    })
  }
  const watchRouting = () => {
    if (released || routing || attaching) return attaching
    return (attaching = attach()
      .catch((error: unknown) =>
        console.error('health: watching subscription routing failed:', error),
      )
      .finally(() => (attaching = undefined)))
  }
  host.onOpen(async () => {
    released = false
    await watchRouting()
  })
  const report = (outcome: ProviderReport) => {
    inProcess(
      'subscription routing may load after health: the next report attaches again',
      settled(watchRouting() ?? Promise.resolve()),
    )
    return notices.report(outcome)
  }
  const release = async () => {
    released = true
    await attaching
    await routing?.stop()
    routing = undefined
    await settled(queue.writes)
  }
  host.onRelease(release)
  host.onClose(release)
  host.react('login-changed', [LoginChanged], async (tx, { data }) => {
    for (const { provider, from, to } of await reset(host.userHome, [data.provider]))
      if (from !== to) await host.emit(tx, Changed, { provider, state: to })
  })
  host.implement(HealthApi, {
    providers: async () =>
      (await readHealth(host.userHome)).filter(
        (entry) => host.modelRuntime.getProviderAuthStatus(entry.provider).configured,
      ),
    report,
  })
  return defineExtension({
    name: 'health',
    hooks: [
      hook(GenerationTask, {
        afterResponse(message) {
          const entry = responseEntry(message, Date.now())
          if (!entry) return
          const hasLocalLogin = host.modelRuntime.getProviderAuthStatus(message.provider).configured
          if (!hasLocalLogin) return
          inProcess(
            'a provider notice is advisory: the next failure of the same provider posts it',
            report(
              message.stopReason === 'error'
                ? { provider: message.provider, ok: false, error: message.errorMessage ?? 'error' }
                : { provider: message.provider, ok: true },
            ),
          )
          const advisoryWrite = recordHealth(
            host.userHome,
            message.provider,
            entry,
            announceHealthFlip,
          )
          inProcess(
            'a health sample is advisory: the next response to the same provider records its state',
            advisoryWrite.catch((error: unknown) => {
              console.error('health: recording a response failed:', error)
            }),
          )
        },
      }),
    ],
  })
}
