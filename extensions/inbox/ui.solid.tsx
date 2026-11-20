/** Inbox for Solid: the open questions and waiting items. */
import { createMemo } from 'solid-js'
import { useAllProvided, ROOT, useDocOf } from '@/sdk/solid'
import { MessagesDoc } from '../messages/refs.ts'
import { emptyMessages } from '../messages/ui.solid.tsx'
import { inboxItems, inboxStatus } from './items.ts'
import { InboxFreshness, InboxItems } from './points.ts'

/**
 * Everything that waits on the user, oldest first: open questions and other extensions' items. `failures` holds the
 * inline error card of each provider that throws; `loaded` tracks local questions and `status` includes provider freshness.
 */
export function Waiting() {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const failures = (<span class="contents" />) as HTMLElement
  const provided = useAllProvided(InboxItems, () => null, failures)
  const statuses = useAllProvided(InboxFreshness, () => null, failures)
  const messages = () => (log() ?? emptyMessages).messages
  const entries = createMemo(() => inboxItems(messages(), provided()))
  const loaded = () => log() !== undefined
  const status = createMemo(() => inboxStatus(loaded(), statuses()))
  return { entries, messages, failures, loaded, status }
}
/** Every provider's waiting items, merged in the Inbox and its counters in waiting order. */
export { InboxItems } from './points.ts'
/** A pane to show instead of the focused question, or undefined to keep the Inbox's own pane. */
export { QuestionPane } from './points.ts'
/** Provider freshness: complete means every source is known fresh; other states may have missing items. */
export { InboxFreshness } from './points.ts'
/** Optional Solid source identity beside the normal asker, receiving the native Inbox entry as props. */
export { InboxSourceChip } from './points.ts'
export { inboxCount } from './items.ts'
export type { InboxStatus } from './points.ts'
/**
 * A waiting item, whose unique key selects it from `?inbox=<key>` or `inbox:open { key }`; `at` is when it started
 * waiting, in epoch milliseconds, and orders the list oldest first.
 */
export type { InboxItem } from './points.ts'
