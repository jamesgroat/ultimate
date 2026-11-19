/** Notices: server and browser notices as toasts under the header, and the Inbox notice service a replacing notices extension may provide. */
import { defineApi } from '../../shared/extension-api.ts'

export const tier = 'core'

export type NoticePost = {
  /** Request key: a key already posted, even one marked Done, never posts again. */
  key: string
  title: string
  /** Markdown for the reading pane. */
  text: string
  /** Row tag, like "Brief"; default "Notice". */
  tag?: string
  /** A newer notice in the same slot replaces the one still waiting there. */
  slot?: string
}

export type NoticesService = {
  /** Post a durable one-way notice to the user's Inbox now; resolves with its id and whether the key was posted already. */
  post(notice: NoticePost): Promise<{ id: number; duplicate: boolean }>
}
/** Durable Inbox notices; `want` it: the built-in notices only toasts, a project notices extension (Life's) provides it. */
export const NoticesApi = defineApi<NoticesService>()('notices')
