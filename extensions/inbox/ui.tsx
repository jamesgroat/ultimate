/** Optional browser source for the built-in Inbox; providers supply data and transport, never a second surface. */
import type { ReactNode } from 'react'
import { definePoint, Provided, useDocOf } from '@/sdk'
import { emptyMessages, MessagesDoc } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import type { MessageQuestionsTransport } from '../questions/ui.tsx'
import { inboxItems } from './items.tsx'

/** An original message plus its source-specific browser presentation and actions. */
export type InboxItem = {
  message: Message
  /** Optional local source label alongside its normal asker; required for remote items. */
  sourceLabel?: string
  /** A usable browser preview URL, or null to hide it. Remote previews are hidden by default. */
  preview?: string | null
} & (
  | { source?: undefined }
  | {
      /** Stable machine/project namespace, independent of connection URLs. */
      source: string
      /** Source/project label, optionally linked to its browser URL (not its server fetch URL). */
      sourceLabel: string
      sourceHref?: string
      /** Remote asker display; omitted numeric askers are shown literally, never looked up locally. */
      asker?: ReactNode
      /** Open the remote branch using a browser-reachable URL. Omit when unavailable. */
      openBranch?: () => void
      /** Remote image content; local MessageImages is never used for this item. */
      images?: ReactNode
      /** Required remote answer/dismiss routing; retain the message's original numeric ID. */
      transport: MessageQuestionsTransport
    }
)

/** Complete means every source is known fresh; all other states may have missing items, even at zero. */
export type InboxStatus = {
  state: 'complete' | 'loading' | 'partial' | 'error'
  text?: string
}

/** Current waiting items and fleet freshness; the Inbox sorts them oldest first. */
export type InboxBoard = { items: readonly InboxItem[]; status: InboxStatus }

/** Receive the local board; return it augmented with remote items and explicit freshness, or undefined for local only. */
export const InboxSource = definePoint<InboxBoard, InboxBoard | undefined>('inbox.source')

/** Live, augmented Inbox data shared by the surface, sidebar and To-dos row, sorted oldest first. */
export function InboxData({
  children,
}: {
  children: (board: InboxBoard, messages: readonly Message[]) => ReactNode
}) {
  const log = useDocOf(1, MessagesDoc)
  const messages = log?.messages ?? emptyMessages.messages
  const local: InboxBoard = {
    items: inboxItems(messages).map((message) => ({ message })),
    status: { state: log === undefined ? 'loading' : 'complete' },
  }
  return (
    <Provided point={InboxSource} input={local}>
      {(provided) => {
        const board = provided ?? local
        return children(
          { ...board, items: board.items.toSorted((a, b) => a.message.at - b.message.at) },
          messages,
        )
      }}
    </Provided>
  )
}

export { itemKey } from './items.tsx'
