import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { configuredModel, familyDefault, hasLogin } from '../../lib/agents.ts'
import { BeforeInput, Family, Pin } from './api.ts'
import type { Fallback } from './refs.ts'
import { FallbackEntry } from './entries.ts'

type Ref = { provider: string; modelId: string }
const name = (ref: Ref) => `${ref.provider}/${ref.modelId}`

export async function fallback(
  host: ExtensionHost,
  tx: Tx,
  conversationId: ConversationId,
): Promise<{ entries: EntryDraft[] } | undefined> {
  const agent = await tx.doc(AgentDoc, conversationId)
  const runtime = host.modelRuntime
  const available = runtime.getAvailableSnapshot()
  const availabilitySnapshotIsUnsettled = !available.length
  if (!agent.model || availabilitySnapshotIsUnsettled || hasLogin(available, agent.model))
    return undefined
  const from = agent.model
  if (
    !runtime.getProvider(from.provider) ||
    (await loginIsPresentOrUnconfirmed(host, from.provider))
  )
    return undefined
  const fresh = runtime.getAvailableSnapshot()
  const requiresSubscriptionReplacement = providerDeclaresSubscriptionAuth(host, from.provider)
  const policy = host.want(BeforeInput)
  const allowed = (ref: Ref) =>
    (!requiresSubscriptionReplacement || runtime.isUsingSubscription(ref.provider)) &&
    (policy?.allowsFallback?.(ref) ?? true)
  const same = fresh.find(
    (model) =>
      model.id === from.modelId &&
      model.provider !== from.provider &&
      allowed({ provider: model.provider, modelId: model.id }),
  )
  const sameModelThenPinThenDefault: [Ref | undefined, Fallback['reason']][] = [
    [same && { provider: same.provider, modelId: same.id }, 'same'],
    [await host.want(Pin)?.pin(tx, conversationId), 'pin'],
    [configuredModel(fresh, host.settings, await familyDefault(host)), 'default'],
  ]
  const eligibleReplacement = sameModelThenPinThenDefault.find(
    ([ref]) => hasLogin(fresh, ref) && allowed(ref!),
  )
  const data: Fallback = eligibleReplacement
    ? { from: name(from), to: name(eligibleReplacement[0]!), reason: eligibleReplacement[1] }
    : { from: name(from), reason: 'none' }
  if (!eligibleReplacement && (await newestFallbackAlreadyAsksUser(tx, conversationId, data.from)))
    return undefined
  if (eligibleReplacement) {
    const to = eligibleReplacement[0]!
    agent.model = { provider: to.provider, modelId: to.modelId }
    const familyClearedByModelFallback = await tx.doc(Family, conversationId)
    familyClearedByModelFallback.name = null
    const model = runtime.getModel(to.provider, to.modelId)
    if (model && agent.thinkingLevel)
      agent.thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
  }
  const content = eligibleReplacement
    ? `Model ${data.from} has no login here; this conversation now runs on ${data.to}.`
    : `Model ${data.from} has no login here and no allowed login can replace it, so this conversation keeps it until the user logs in to ${from.provider} or picks another model.`
  return {
    entries: [
      { kind: FallbackEntry.kind, data, model: [{ role: 'user', content, timestamp: Date.now() }] },
    ],
  }
}

const INPUT_TRANSACTION_AUTH_CHECK_TIMEOUT_MS = 5_000

async function loginIsPresentOrUnconfirmed(host: ExtensionHost, provider: string) {
  try {
    return !!(await host.modelRuntime.checkAuth(provider, {
      signal: AbortSignal.timeout(INPUT_TRANSACTION_AUTH_CHECK_TIMEOUT_MS),
    }))
  } catch (error) {
    host.notice(`Checking the ${provider} login failed, keeping the model: ${String(error)}`)
    return true
  }
}

function providerDeclaresSubscriptionAuth(host: ExtensionHost, provider: string) {
  return host.modelRuntime.getProvider(provider)?.auth.oauth?.isSubscription === true
}

async function newestFallbackAlreadyAsksUser(tx: Tx, conversationId: ConversationId, from: string) {
  for (let page = await tx.scanEntries({ conversationId }, 200); ;) {
    const entry = page.items.find((candidate) => FallbackEntry.is(candidate))
    if (entry) {
      const data = entry.data
      return data.reason === 'none' && data.from === from
    }
    if (!page.next) return false
    page = await tx.scanEntries({ conversationId }, 200, page.next)
  }
}
