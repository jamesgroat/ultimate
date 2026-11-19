/**
 * Health: whether each model provider with a login on this machine works, from its real calls, kept in
 * `~/.ultimate/health.json`, and one Inbox notice when a provider runs out of credits, hits a usage limit or rejects
 * its login.
 */
import { defineApi } from '../../shared/extension-api.ts'
import type { ProviderHealth } from './refs.ts'

export type { ProviderHealth }

/** One outcome of a call to `provider` that is not a model response (those health records itself). */
export type ProviderReport = {
  provider: string
  ok: boolean
  /** The HTTP status of a failure, when the caller has one. */
  status?: number
  /** The failure's message or response body; only classified, never stored or shown. */
  error?: string
  /** When a usage limit resets, epoch ms, when the caller knows it. */
  resetsAt?: number
}

export interface HealthService {
  /** This machine's provider health, from `~/.ultimate/health.json`; use it before relying on a provider. */
  providers(): Promise<ProviderHealth[]>
  /**
   * Report a call's outcome: a billing, usage or auth failure opens an episode and posts its one Inbox notice; a success
   * closes the provider's episode. Never throws for a notice it could not post.
   */
  report(report: ProviderReport): Promise<void>
}
/** Provider health; `want` it, since health is optional. */
export const HealthApi = defineApi<HealthService>()('health')
