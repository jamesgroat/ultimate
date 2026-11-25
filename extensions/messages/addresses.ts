import { parseConversationId } from '../../lib/ids.ts'
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  SubmissionId,
  Tx,
  TaskId,
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { FiredEntry, FinishedEntry, MessageEntry, ReplyEntry } from '../entries/api.ts'
import { LanderReportEntry, WorkspacesApi } from '../workspaces/api.ts'
import type { DeliveredMessage } from './refs.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, Subagents, SubagentsApi } from '../subagents/api.ts'
import type { Remote, Serves } from './refs.ts'
import { Messages } from './api.ts'
import { Roots, Tally } from '../lineage/api.ts'
import { isOpen } from '../../lib/message-state.ts'

export type { Serves }

export type Owner =
  | { kind: 'branch'; id: ConversationId }
  | { kind: 'automation'; id: string }
  | { kind: 'tell'; key: string }

export type LandingOutput = `landing:${string}`

export const Serving = defineDoc<{
  owners: Record<
    string,
    {
      request: Serves
      owner: Owner
      assignedBy: EntryId
      pending: (SubmissionId | LandingOutput)[]
    }
  >
}>({
  kind: 'board.serving',
  checkpointWhen: () => false,
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ owners: {} }),
  migrate: () => ({ owners: {} }),
})

export const RequestRun = defineDoc<{
  run?: SubmissionId
  selected?: number
  acknowledged: number[]
  nudge?: TaskId
}>({
  kind: 'board.request-run',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ acknowledged: [] }),
})

export async function requestRun(tx: Tx, to: ConversationId) {
  const state = await tx.doc(RequestRun, to)
  const run = (await tx.doc(LiveDoc, to)).run?.inputs[0]
  if (state.run !== run) {
    state.run = run
    delete state.selected
    delete state.nudge
    state.acknowledged = []
  }
  return state
}

export const EarlyReplies = defineDoc<{ pending: Record<string, { settledBy?: EntryId }> }>({
  kind: 'board.early-replies',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ pending: {} }),
})

export const sameOwner = (a: Owner, b: Owner) =>
  a.kind === 'tell' ? b.kind === 'tell' && a.key === b.key : b.kind === a.kind && a.id === b.id

export async function runInputs(tx: Tx, to: ConversationId) {
  const entries: EntryRecord[] = []
  for (const id of (await tx.doc(LiveDoc, to)).run?.inputs ?? []) {
    const record = await tx.submission(id)
    if (record?.type !== 'input' || record.entry === undefined) continue
    const entry = await tx.entry(record.entry)
    if (entry) entries.push(entry)
  }
  return entries
}

export async function ownerOutput(
  host: ExtensionHost,
  tx: Tx,
  to: ConversationId,
  entry: EntryRecord | undefined,
): Promise<{ owner: Owner; source: string } | undefined> {
  if (FiredEntry.is(entry) || FinishedEntry.is(entry))
    return {
      owner: { kind: 'automation', id: entry.data.id },
      source: `automation ${entry.data.id} "${entry.data.name}"`,
    }
  if (
    ReplyEntry.is(entry) &&
    entry.data.from === 'remote' &&
    entry.data.remote &&
    !entry.data.interim
  )
    return {
      owner: { kind: 'tell', key: entry.data.remote.key },
      source: `tell to ${remoteLabel(entry.data.remote)}`,
    }
  let branch: ConversationId | undefined
  if (LanderReportEntry.is(entry))
    branch = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).results[
      entry.data.id
    ]?.conversationId
  if (
    (ReplyEntry.is(entry) ||
      (MessageEntry.is(entry) &&
        (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
          (m) => m.id === entry.data.id && m.report,
        ))) &&
    typeof entry.data.from === 'number' &&
    !entry.data.echo
  )
    branch = entry.data.from
  if (branch !== undefined && (await tx.doc(Started, branch)).by === to)
    return { owner: { kind: 'branch', id: branch }, source: `#${branch}` }
  return undefined
}

export async function serve(host: ExtensionHost, tx: Tx, to: ConversationId, owner: Owner) {
  if ((await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate !== to) return []
  const inputs = await runInputs(tx, to)
  const assignedBy = inputs.at(-1)?.id
  if (assignedBy === undefined) return []
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  const read = new Set(inputs.flatMap((entry) => (MessageEntry.is(entry) ? [entry.data.id] : [])))
  const requests = new Map<number, Serves>()
  for (const m of (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages) {
    if (m.to !== to || m.from === 'user' || m.ownerSettled || !isOpen(m) || !read.has(m.id))
      continue
    const request = {
      message: m.id,
      from: m.from,
      ...(m.remote ? { remote: { ...m.remote } } : {}),
    }
    requests.set(m.id, request)
  }
  for (const entry of inputs) {
    const output = await ownerOutput(host, tx, to, entry)
    if (!output) continue
    for (const { request, owner: current } of Object.values(owners))
      if (sameOwner(current, output.owner)) requests.set(request.message, request)
  }
  const state = await requestRun(tx, to)
  const selected = state.selected
  if (selected !== undefined) {
    const message = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
      (m) => m.id === selected && m.to === to && m.from !== 'user' && isOpen(m) && !m.ownerSettled,
    )
    if (!message || message.from === 'user')
      throw new Error(`Request ${selected} is no longer outstanding`)
    requests.clear()
    requests.set(selected, {
      message: selected,
      from: message.from,
      ...(message.remote ? { remote: message.remote } : {}),
    })
  }
  if (requests.size > 1)
    throw new Error(
      `Several requests are eligible (${[...requests.keys()].join(', ')}). Select one with request { id, action: 'work' } before delegating.`,
    )
  for (const request of requests.values()) {
    owners[request.message] = { request, owner, assignedBy, pending: [] }
  }
  return [...requests.values()]
}

export async function branchesReadThisRun(tx: Tx, to: ConversationId) {
  const log = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
  const read = new Set<ConversationId>()
  for (const entry of await runInputs(tx, to)) {
    const data: Partial<DeliveredMessage> | undefined =
      MessageEntry.is(entry) || ReplyEntry.is(entry) ? entry.data : undefined
    if (!ReplyEntry.is(entry) && !(MessageEntry.is(entry) && data?.reply === false)) continue
    if (typeof data?.from !== 'number' || data.echo === true) continue
    if ((await tx.doc(Started, data.from)).by !== to) continue
    const since = data.id ?? 0
    if (!log.some((m) => m.from === to && m.to === data.from && m.id > since)) read.add(data.from)
  }
  return [...read]
}

export async function owed(host: ExtensionHost, tx: Tx, to: ConversationId, automation?: string) {
  if (automation !== undefined) await serve(host, tx, to, { kind: 'automation', id: automation })
  const branches = await branchesReadThisRun(tx, to)
  return branches.length ? { branches } : {}
}

export const Started = defineDoc<{
  by?: ConversationId
  yielded?: TaskId
  lastRoute?: TaskId<null>
}>({
  kind: 'board.started',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export async function starterOf(host: ExtensionHost, id: ConversationId | 'user', ctx: Context) {
  if (typeof id !== 'number') return undefined
  return (await host.harness().snapshot(Started, id, ctx))?.by
}

export async function servesLine(
  tx: Tx,
  from: ConversationId | 'user' | 'remote',
  to: ConversationId | 'user' | 'remote',
) {
  if (typeof from !== 'number') return ''
  if ((await tx.doc(Started, from)).by !== to) return ''
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  return Object.values(owners)
    .flatMap(({ request, owner }) => {
      if (owner.kind !== 'branch' || owner.id !== from) return []
      const label = request.remote ? remoteLabel(request.remote) : `#${request.from}`
      return [
        `\n#${from} works on ${label}'s message ${request.message}. To return its result to ${label}, explicitly reply to request ${request.message}; final prose leaves it open.`,
      ]
    })
    .join('')
}

export async function refreshStandingDefinition(
  host: ExtensionHost,
  id: ConversationId,
  ctx: Context,
) {
  const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const name = Object.keys(index ?? {}).find((candidate) => index![candidate] === id)
  if (name === undefined) return
  const service = host.need(SubagentsApi)
  if ((await service.residents(ctx)).some((agent) => agent.name === name))
    await service.standing(name, ctx)
}

export async function hasRequestTool(host: ExtensionHost, id: ConversationId, ctx: Context) {
  const agent = await (await host.harness().conversation(id, ctx))?.agent(ctx)
  return agent?.tools.some((tool) => tool.name === 'request') === true
}

export async function requireRequestTool(host: ExtensionHost, id: ConversationId, ctx: Context) {
  if (!(await hasRequestTool(host, id, ctx)))
    throw new Error(
      `#${id} cannot accept a reply-expected request: its request completion tool is unavailable or denied. Send a one-way note instead.`,
    )
}

export async function parentOf(host: ExtensionHost, id: ConversationId, ctx: Context) {
  const owner = (await host.harness().commit((tx) => tx.conversation(id), ctx))?.owner
    ?.conversationId
  if (owner === undefined) return undefined
  return (await host.harness().snapshot(Subagents, owner, ctx))?.agents[String(id)]
    ? owner
    : undefined
}
export async function senderName(
  host: ExtensionHost,
  id: ConversationId | 'user' | 'remote',
  ctx: Context,
) {
  if (id === 'user') return 'user'
  if (typeof id !== 'number') return 'another Ultimate'
  const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const name = Object.keys(index ?? {}).find((candidate) => index?.[candidate] === id)
  return `#${id}${name ? ` (@${name})` : ''}`
}
export async function resolveRecipient(
  host: ExtensionHost,
  to: string,
  from: ConversationId | 'user',
  ctx: Context,
) {
  if (to === 'user') return to
  let id: ConversationId | undefined
  if (to.startsWith('@')) {
    const service = host.need(SubagentsApi)
    const valid = await service.residents(ctx)
    if (!valid.some((item) => `@${item.name}` === to))
      throw new Error(
        `Unknown address ${to}. Valid standing agents: ${valid.map((item) => `@${item.name}`).join(', ') || '(none)'}`,
      )
    id = await service.standing(to.slice(1), ctx)
  } else if (/^#?\d+$/.test(to)) id = parseConversationId(Number(to.replace('#', '')))
  if (id === undefined) throw new Error(`No recipient for ${to}`)
  if (id === from) throw new Error('You cannot message yourself')
  await host.harness().commit(async (tx) => {
    if (!(await tx.conversation(id))) throw new Error(`Unknown conversation #${id}`)
    const { roots } = await tx.doc(Roots, ROOT_CONVERSATION_ID)
    if (roots.includes(id) && (await tx.doc(Tally, id)).since !== undefined)
      throw new Error(`#${id} is a tally and takes no inputs; use note instead`)
  }, ctx)
  return id
}

export const remoteLabel = (remote: Pick<Remote, 'project' | 'machine'>) =>
  `@ultimate@${remote.project} on ${remote.machine}`
