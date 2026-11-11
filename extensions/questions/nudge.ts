import {
  defineDoc,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Messages } from '../messages/api.ts'
import { Standing } from '../subagents/api.ts'
import { openQuestion } from '../../lib/message-state.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'

const Attempt = defineDoc<{ run?: number; generation?: number }>({
  kind: 'questions.final-ask-attempt',
  version: 1,
  checkpointWhen: () => false,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** Deliberately misses ambiguous asks rather than treating every question mark as a decision. */
export function finalAsk(text: string) {
  const prose = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\s*\1[^\n]*(?:\n|$)|(?![\s\S]))/gm, '')
    .replace(/^(?: {4}|\t|\s*>).*$/gm, '')
    .replace(/`+[^`]*`+|"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]+'(?!\w)/g, '')
    .replace(/\*\*|__/g, '')
  return /(?:^|[.!]\s+|\n)\s*(?:[-*]\s+)?(?:want me to\b|should I\b|(?:do you want|would you like|(?:can|could|would|will) you|are you ready|which (?:option|approach) do you|what would you prefer)\b)[^?\n]*\?/im.test(
    prose,
  )
}

const NUDGE =
  'Your final prose appears to ask the user for a decision, but it has no answer card. If a response is needed, send the actual question with message { to: "user", text, questions } using the appropriate question kinds and options. Otherwise state your conclusion without asking. Do not invent or answer a decision. This is the only corrective nudge for this run.'

export function finalAskNudge(host: ExtensionHost) {
  return hook(GenerationTask, {
    onYield: async (answer, api, ctx) => {
      if (!finalAsk(answer.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')))
        return undefined
      if (
        (await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate !== api.conversationId
      )
        return undefined
      // Invalid user JSON is reported by settings discovery; here it counts as unset.
      const user = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
      const project = await host.projectSettings()
      type Config = { questions?: { nudgeFinalAsk?: boolean } }
      const enabled =
        (project as Config).questions?.nudgeFinalAsk ?? (user as Config).questions?.nudgeFinalAsk
      if (enabled === false) return undefined
      const conversation = await host.harness().conversation(api.conversationId, ctx)
      if (!(await conversation?.agent(ctx))?.tools.some((tool) => tool.name === 'message'))
        return undefined
      const run = (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run
      if (!run?.inputs.length) return undefined
      // Model role is not provenance: board.open and remote/branch deliveries can also have role user.
      // Every placed input must be the user's; mixed or unknown origins are deliberately left alone.
      for (const id of run.inputs) {
        const input = await (await host.harness().submission(id, ctx))?.status(ctx)
        if (input?.type !== 'input' || input.status !== 'placed') return undefined
        const entry = await api.entry(input.entry, ctx)
        if (
          entry?.kind !== 'pi.user' &&
          entry?.kind !== 'voice.utterance' &&
          !(
            entry?.kind === 'board.message' &&
            (entry.data as { from?: unknown } | undefined)?.from === 'user'
          )
        )
          return undefined
      }
      const claimed = await host.harness().commit(async (tx) => {
        const current = (await tx.doc(LiveDoc, api.conversationId)).run
        if (
          current?.taskId !== api.taskId ||
          current.inputs.length !== run.inputs.length ||
          current.inputs.some((id, i) => id !== run.inputs[i])
        )
          return false
        if (
          (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
            (m) => m.from === api.conversationId && openQuestion(m),
          )
        )
          return false
        // Fork correction #142546: an uncarded final ask was missed by the user. Pi Durable 1.5.0
        // hands continuations to new generations and resets turns; cap by the ORIGINAL run's first
        // submission, not generation. Replaying the claiming generation must return the same nudge.
        const attempt = await tx.doc(Attempt, api.conversationId)
        if (attempt.run === run.inputs[0]) return attempt.generation === api.taskId
        attempt.run = run.inputs[0]
        attempt.generation = api.taskId
        return true
      }, ctx)
      return claimed ? { continue: NUDGE } : undefined
    },
  })
}
