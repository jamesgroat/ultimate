import { expect, it, vi } from 'vitest'
import { AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { BeforeInput, Family, Pin } from '../api.ts'
import { checkLogin, fallback, loginChecks } from '../fallback.ts'

vi.mock('../../../lib/agents.ts', async (original) => ({
  ...(await original<typeof import('../../../lib/agents.ts')>()),
  familyDefault: async () => undefined,
}))

const id = 2 as ConversationId
const original = { provider: 'claude-code', modelId: 'model-1' }
function fixture(provider: string, permits = true) {
  const replacement = { provider, modelId: original.modelId }
  let snapshot = [{ provider, id: replacement.modelId }]
  const checkAuth = vi.fn<() => Promise<boolean>>(async () => false)
  const allowsFallback = vi.fn<() => boolean>(() => permits)
  const agent = { model: original }
  const family = { name: 'review' }
  const host = {
    modelRuntime: {
      getAvailableSnapshot: () => snapshot,
      checkAuth,
      getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
      isUsingSubscription: () => true,
      getModel: () => undefined,
    },
    settings: { getDefaultProvider: () => provider, getDefaultModel: () => replacement.modelId },
    want: (point: unknown) =>
      point === BeforeInput
        ? { allowsFallback }
        : point === Pin
          ? { pin: async () => replacement }
          : undefined,
    notice: vi.fn<ExtensionHost['notice']>(),
  } as unknown as ExtensionHost
  const tx = {
    doc: async (doc: unknown) => (doc === AgentDoc ? agent : doc === Family ? family : undefined),
    scanEntries: async () => ({ items: [] }),
  } as unknown as Tx
  return {
    host,
    tx,
    agent,
    family,
    checkAuth,
    allowsFallback,
    changeSnapshot: () => {
      snapshot = [...snapshot]
    },
  }
}

it('never replaces a missing subscription with a paid Anthropic route, even if marked subscription', async () => {
  const f = fixture('anthropic')
  const checks = loginChecks()
  await checkLogin(f.host, id, original, checks)
  const result = await fallback(f.host, f.tx, id, checks)
  expect(f.agent.model).toEqual(original)
  expect(f.family.name).toBe('review')
  expect(result?.entries[0].data).toEqual({ from: 'claude-code/model-1', reason: 'none' })
})

it('lets policy reject same-model, pin and default fallback candidates', async () => {
  const f = fixture('subscription-peer', false)
  const checks = loginChecks()
  await checkLogin(f.host, id, original, checks)
  const result = await fallback(f.host, f.tx, id, checks)
  expect(f.agent.model).toEqual(original)
  expect(f.allowsFallback).toHaveBeenCalledWith({
    provider: 'subscription-peer',
    modelId: 'model-1',
  })
  expect(result?.entries[0].data).toEqual({ from: 'claude-code/model-1', reason: 'none' })
  expect(f.checkAuth).toHaveBeenCalledTimes(1)
})

it('does no auth I/O on placement when policy changes provider or the prepared snapshot goes stale', async () => {
  const f = fixture('subscription-peer')
  const checks = loginChecks()
  await checkLogin(f.host, id, original, checks)
  f.changeSnapshot()
  expect(await fallback(f.host, f.tx, id, checks)).toBeUndefined()
  f.agent.model = { provider: 'another-subscription', modelId: 'model-1' }
  expect(await fallback(f.host, f.tx, id, checks)).toBeUndefined()
  expect(f.checkAuth).toHaveBeenCalledTimes(1)
})
