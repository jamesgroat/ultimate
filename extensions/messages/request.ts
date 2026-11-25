import {
  defineDoc,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import type { ExtensionHost } from '../../server/extensions.ts'
import { safeToRerun } from '../../lib/replay.ts'
import { REQUEST_DESCRIPTION } from '../../lib/request-description.ts'
import { isOpen, isOwed } from '../../lib/message-state.ts'
import { Messages } from './api.ts'
import { ownerOutput, requestRun, runInputs, sameOwner, Serving } from './addresses.ts'
import { MessageEntry } from '../entries/api.ts'
import { sendResult } from './delivery.ts'
import { hasBusyDescendant, working } from './route.ts'

const Receipts = defineDoc<{ calls: Record<string, number> }>({
  kind: 'board.request-receipts',
  version: 1,
  checkpointWhen: () => false,
  scope: 'task',
  initial: () => ({ calls: {} }),
})

export const requestTool = (host: ExtensionHost) =>
  defineTool({
    name: 'request',
    description: REQUEST_DESCRIPTION,
    parameters: obj({ id: num(), action: str(), text: opt(str()) }),
    ...safeToRerun(
      'The completion and task call receipt commit together; replay returns the recorded id.',
    ),
    async execute(input, api, ctx) {
      if (input.action !== 'work' && input.action !== 'reply')
        throw new Error('action must be work or reply')
      const id = await host.harness().commit(async (tx) => {
        const receipts = await tx.doc(Receipts, api.taskId)
        if (receipts.calls[api.callId] !== undefined) return receipts.calls[api.callId]
        if (!Number.isSafeInteger(input.id) || input.id < 1)
          throw new Error('id must be a local request id')
        const message = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
          (m) => m.id === input.id,
        )
        if (
          !message ||
          message.to !== api.conversationId ||
          message.from === 'user' ||
          !isOpen(message) ||
          message.ownerSettled
        )
          throw new Error(
            `Request ${input.id} is not an outstanding agent request addressed to you`,
          )
        const state = await requestRun(tx, api.conversationId)
        if (input.action === 'work') {
          state.selected = input.id
          if (!state.acknowledged.includes(input.id)) state.acknowledged.push(input.id)
        } else {
          if (!input.text?.trim()) throw new Error('reply requires nonempty text')
          await sendResult(
            host,
            tx,
            api.conversationId,
            {
              message: message.id,
              from: message.from,
              ...(message.remote ? { remote: message.remote } : {}),
            },
            input.text,
            { reply: true, replyRun: state.run },
          )
          message.state = 'answered'
          delete (await tx.doc(Serving, ROOT_CONVERSATION_ID)).owners[message.id]
          if (state.selected === message.id) delete state.selected
        }
        receipts.calls[api.callId] = input.id
        return input.id
      }, ctx)
      return {
        output: [
          {
            type: 'text',
            text: `Request ${id}: ${input.action === 'work' ? 'continuing work' : 'answered'}.`,
          },
        ],
      }
    },
  })

export function requestNudge(host: ExtensionHost) {
  return hook(GenerationTask, {
    onYield: async (_answer, api, ctx) => {
      const claimed = await host.harness().commit(async (tx) => {
        const run = (await tx.doc(LiveDoc, api.conversationId)).run
        if (!run || run.taskId !== api.taskId) return []
        const state = await requestRun(tx, api.conversationId)
        if (state.nudge !== undefined && state.nudge !== api.taskId) return []
        const inputs = await runInputs(tx, api.conversationId)
        const read = new Set(
          inputs.flatMap((entry) => (MessageEntry.is(entry) ? [entry.data.id] : [])),
        )
        const messages = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
        const open = messages.filter(
          (m) =>
            m.to === api.conversationId &&
            m.from !== 'user' &&
            isOpen(m) &&
            !m.ownerSettled &&
            (isOwed(m) || read.has(m.id)) &&
            !state.acknowledged.includes(m.id),
        )
        if (!open.length) return []
        if (
          open.length === 1 &&
          ((await hasBusyDescendant(tx, api.conversationId)) ||
            messages.some((m) => m.from === api.conversationId && m.to !== 'user' && isOpen(m)))
        )
          return []
        const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
        const outputs = await Promise.all(
          inputs.map((entry) => ownerOutput(host, tx, api.conversationId, entry)),
        )
        const eligible: number[] = []
        for (const m of open) {
          const current = owners[m.id]
          if (
            current &&
            !outputs.some((output) => output && sameOwner(output.owner, current.owner)) &&
            (current.pending.length ||
              current.owner.kind !== 'branch' ||
              (await working(tx, current.owner.id)))
          )
            continue
          eligible.push(m.id)
        }
        if (eligible.length) state.nudge = api.taskId
        return eligible
      }, ctx)
      return claimed.length
        ? {
            continue: `Agent requests ${claimed.join(', ')} remain unanswered. Use request { id, action: 'reply', text } to answer exactly one, or request { id, action: 'work' } to record continuing work. Final prose does not answer them. This is the only corrective nudge this run.`,
          }
        : undefined
    },
  })
}
