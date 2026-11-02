/**
 * Models: the model and thinking pickers and provider logins in the composer, and the `models.pin` point through which
 * a conversation whose model lost its login finds its definition's model. Core tier.
 */
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
export { LoginChanged } from './refs.ts'
export type PinService = {
  /** The model the definition conversation `id` runs as pins, read inside `tx`; undefined without one. */
  pin(tx: Tx, id: ConversationId): Promise<{ provider: string; modelId: string } | undefined>
}
/**
 * The extension point a conversation whose model lost its login asks for the model its agent definition pins, before
 * it falls back to the default model. Subagents provides it (it records which definition a conversation runs as).
 */
export const Pin = defineApi<PinService>()('models.pin')
/** Persistent model-selection intent; automatic configuration alone never changes it. Unset means no recorded intent. */
export const Selection = defineDoc<{
  mode?: 'manual' | 'auto'
  model?: { provider: string; modelId: string }
  selectedAt?: number
}>({
  kind: 'models.selection',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export type BeforeInputService = {
  /** Apply optional model policy inside the input transaction, before the independent missing-login fallback. */
  beforeInput(tx: Tx, conversationId: ConversationId): Promise<void>
}
/** Optional input-time model policy; implementations must use only transactional writes, not network I/O. */
// oxlint-disable-next-line ultimate/api-naming -- matches the transactional beforeInput hook this point extends.
export const BeforeInput = defineApi<BeforeInputService>()('models.beforeInput')
export const tier = 'core'
