import { expect, it, vi } from 'vitest'
import { AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { BeforeInput, Family, Pin } from '../api.ts'
import { fallback } from '../fallback.ts'

vi.mock('../../../lib/agents.ts', async (original) => ({
  ...(await original<typeof import('../../../lib/agents.ts')>()),
  familyDefault: async () => undefined,
}))

const target = { provider: 'anthropic', modelId: 'claude-opus-5-5' }

function fixture(oauth: boolean, permits = true, provider = target.provider) {
  const replacement = { ...target, provider }
  const agent = { model: { provider: 'claude-code', modelId: target.modelId } }
  const family = { name: 'default' as string | null }
  const available = [{ provider: replacement.provider, id: replacement.modelId }]
  const host = {
    modelRuntime: {
      getAvailableSnapshot: () => available,
      getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
      checkAuth: async () => undefined,
      isUsingSubscription: (name: string) => name === replacement.provider && oauth,
      getModel: () => undefined,
    },
    settings: {
      getDefaultProvider: () => replacement.provider,
      getDefaultModel: () => target.modelId,
    },
    want: (point: unknown) =>
      point === BeforeInput
        ? { allowsFallback: () => permits }
        : point === Pin
          ? { pin: async () => replacement }
          : undefined,
  } as unknown as ExtensionHost
  const tx = {
    doc: async (doc: unknown) => (doc === AgentDoc ? agent : doc === Family ? family : undefined),
    scanEntries: async () => ({ items: [] }),
  } as unknown as Tx
  return { host, tx, agent, family }
}

it('preserves the Anthropic per-token exclusion even when its login is marked subscription', async () => {
  const f = fixture(true)
  const result = await fallback(f.host, f.tx, 2 as ConversationId)
  expect(f.agent.model.provider).toBe('claude-code')
  expect(f.family.name).toBe('default')
  expect(result?.entries[0].data).toEqual({ from: 'claude-code/claude-opus-5-5', reason: 'none' })
})

it('never replaces a missing subscription with an Anthropic API key', async () => {
  const f = fixture(false)
  const result = await fallback(f.host, f.tx, 2 as ConversationId)
  expect(f.agent.model.provider).toBe('claude-code')
  expect(result?.entries[0].data).toEqual({ from: 'claude-code/claude-opus-5-5', reason: 'none' })
})

it('lets input policy reject subscription routes in same-model, pin and default candidates', async () => {
  const f = fixture(true, false, 'subscription-peer')
  const result = await fallback(f.host, f.tx, 2 as ConversationId)
  expect(f.agent.model.provider).toBe('claude-code')
  expect(f.family.name).toBe('default')
  expect(result?.entries[0].data).toEqual({ from: 'claude-code/claude-opus-5-5', reason: 'none' })
})
