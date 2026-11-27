import type { ConversationId } from '@earendil-works/pi-durable'
import type { JSX } from '@solidjs/web'
import type { MarkdownOrigin } from '../../web/src/components/markdown/source.ts'
import { definePoint } from '../../web/src/sdk/types.ts'
import type { Message } from '../messages/refs.ts'

export type InboxItem = {
  key: string
  at: number
  conversation?: ConversationId
  tag: string
  title: string
  gist?: string
  pane: JSX.Element
  origin?: MarkdownOrigin
}

export const InboxItems = definePoint<null, InboxItem[]>('inbox.items')
export const QuestionPane = definePoint<
  { message: Message | undefined; phone: boolean },
  (() => JSX.Element) | undefined
>('inbox.question-pane')
