import type { ConversationId, EntryId, SubmissionId, TaskId, Tx } from '@earendil-works/pi-durable'
import { defineDocFamily, LiveDoc } from '@earendil-works/pi-durable'
import { MessageEntry, ReplyEntry } from '../entries/api.ts'

export const UserInputs = defineDocFamily<{ submissions: SubmissionId[] }, null>({
  kind: 'board.user-inputs',
  checkpointWhen: () => false,
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ submissions: [] }),
})

export async function captureUserInputs(tx: Tx, conversation: ConversationId, task: TaskId) {
  const submissions: SubmissionId[] = []
  for (const id of (await tx.doc(LiveDoc, conversation)).run?.inputs ?? []) {
    const input = await tx.submission(id)
    if (input?.type !== 'input' || input.entry === undefined) continue
    const entry = await tx.entry(input.entry)
    if (
      entry?.kind === 'pi.user' ||
      entry?.kind === 'voice.utterance' ||
      ((MessageEntry.is(entry) || ReplyEntry.is(entry)) && entry.data.from === 'user')
    )
      submissions.push(id)
  }
  ;(await tx.doc(UserInputs, conversation, String(task), null)).submissions = submissions
}

export async function answerUserInputs(tx: Tx, answer: EntryId | undefined): Promise<EntryId[]> {
  if (answer === undefined) return []
  const entry = await tx.entry(answer)
  if (entry?.byTaskId === undefined) return []
  const entries: EntryId[] = []
  const captured = await tx.doc(UserInputs, entry.conversationId, String(entry.byTaskId), null)
  for (const id of captured.submissions) {
    const input = await tx.submission(id)
    if (input?.type === 'input' && input.status === 'done' && input.answer === answer)
      entries.push(input.entry)
  }
  return entries
}
