import type { ConversationId } from '@earendil-works/pi-durable'
import type { JSX } from '@solidjs/web'
import { definePoint } from '../../web/src/sdk/types.ts'
import type { Message } from '../messages/refs.ts'
import type { Entry } from './items.ts'

export type InboxItem = {
  key: string
  at: number
  conversation?: ConversationId
  tag: string
  title: string
  gist?: string
  pane: JSX.Element
}

export type InboxStatus = {
  state: 'complete' | 'loading' | 'partial' | 'error'
  text?: string
}

export const InboxFreshness = definePoint<null, InboxStatus>('inbox.freshness')
export const InboxSourceChip = definePoint<Entry, JSX.Element>('inbox.sourceChip')
export const InboxItems = definePoint<null, InboxItem[]>('inbox.items')
export const QuestionPane = definePoint<
  { message: Message | undefined; phone: boolean },
  (() => JSX.Element) | undefined
>('inbox.question-pane')
