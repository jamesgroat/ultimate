/** Watchdog failure cards: the failed conversation, the kind and first line of its error, last step and retry outcome. */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
/** What kind of failure ended the run, so a reader can act on it without the error text. */
export type FailureClass = 'rate-limit' | 'login' | 'provider' | 'delivery' | 'other'
export type Failure = {
  conversation: ConversationId
  title: string
  class?: FailureClass
  /** The error's first line, secrets masked; the full text stays in the failed conversation, at `entry`. */
  error: string
  /** The failed conversation's entry holding the error, when there is one. */
  entry?: EntryId
  step: string
  hint?: string
  retried: boolean
}
