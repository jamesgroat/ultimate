import { expect, it } from 'vitest'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { listModels } from '../server/models.ts'

it.each([
  { configured: true, available: true, oauth: true, subscription: true, billing: 'subscription' },
  { configured: true, available: true, oauth: false, subscription: false, billing: 'paid-api' },
  { configured: false, available: false, oauth: false, subscription: false, billing: 'unknown' },
  { configured: true, available: false, oauth: false, subscription: false, billing: 'unknown' },
  { configured: true, available: true, oauth: true, subscription: false, billing: 'unknown' },
])(
  'reports resolved Anthropic billing as $billing ($oauth / $available / $configured)',
  async (auth) => {
    const available = auth.available ? [{ provider: 'anthropic', id: 'claude-opus-5-5' }] : []
    const runtime = {
      getAvailable: async () => available,
      getAvailableSnapshot: () => available,
      getProviders: () => [{ id: 'anthropic', auth: {} }],
      getAllModels: () => [],
      getProviderAuthStatus: () => ({ configured: auth.configured }),
      hasConfiguredAuth: () => auth.configured,
      isUsingOAuth: () => auth.oauth,
      isUsingSubscription: () => auth.subscription,
    } as unknown as ModelRuntime
    expect((await listModels(runtime)).providers[0].billing).toBe(auth.billing)
  },
)
