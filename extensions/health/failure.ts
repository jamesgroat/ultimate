import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { failureKind } from './store.ts'
import type { FailureClass, ProviderReport } from './api.ts'
export type { FailureClass }

const BILLING = /\bcredits?\b|insufficient[ _]funds|billing_error|payment required|out of budget/i
const USAGE =
  /usage[ _]limit|usage_not_included|insufficient_quota|quota exceeded|exceeded your (?:current )?quota|hit your (?:\w+ )?limit|extra usage|usage credits/i
const LOGGED_OUT = /not logged in|logged out|log in again|OAuth refresh failed/i

const MINUTE = 60_000
export function resetsAtOf(error: string, now: number): number | undefined {
  const epoch =
    /"?resets_?at"?\s*[:=]\s*(\d{9,13})/i.exec(error)?.[1] ??
    /limit reached\|(\d{9,13})/i.exec(error)?.[1]
  if (epoch) return epoch.length > 10 ? Number(epoch) : Number(epoch) * 1000
  const minutes = /try again in ~?(\d+)\s*min/i.exec(error)?.[1]
  if (minutes) return now + Number(minutes) * MINUTE
  const iso = /resets? (?:at )?(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d))/i.exec(error)?.[1]
  const at = iso ? Date.parse(iso) : NaN
  return Number.isFinite(at) ? at : undefined
}
export function classifyFailure(
  failure: { status?: number; error: string },
  now = Date.now(),
): { class: FailureClass; resetsAt?: number } {
  const text = failure.status ? `${failure.status} ${failure.error}` : failure.error
  const kind = failureKind(text)
  const resetsAt = resetsAtOf(text, now)
  const withReset = (cls: FailureClass) => ({ class: cls, ...(resetsAt ? { resetsAt } : {}) })
  if (kind === 'auth' || LOGGED_OUT.test(text)) return { class: 'auth' }
  if (kind === 'billing') return { class: 'billing' }
  const retryable = isRetryableAssistantError({
    stopReason: 'error',
    errorMessage: text,
  } as AssistantMessage)
  const exhausted = !retryable || /usage_limit_reached|usage_not_included/i.test(text)
  if (exhausted && USAGE.test(text)) return withReset('usage')
  if (BILLING.test(text)) return { class: 'billing' }
  if (kind === 'capacity' && !retryable) return withReset('usage')
  return { class: 'other' }
}

export function failureReport(
  provider: string,
  failure: { status?: number; error: string },
  now = Date.now(),
): ProviderReport {
  const classified = classifyFailure(failure, now)
  return {
    provider,
    ok: false,
    failure: classified.class,
    ...(classified.resetsAt ? { resetsAt: classified.resetsAt } : {}),
  }
}
