import {
  defineDoc,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { SubmissionId, TaskId } from '@earendil-works/pi-durable'
import { meansNone } from '../../lib/errors.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Messages } from '../messages/api.ts'
import { Standing } from '../subagents/api.ts'
import { openQuestion } from '../../lib/message-state.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { ClassifyApi } from '../classify/api.ts'

const Attempt = defineDoc<{ run?: SubmissionId; generation?: TaskId }>({
  kind: 'questions.final-ask-attempt',
  version: 1,
  checkpointWhen: () => false,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const FINAL_ASK_PROBABILITY = 0.8
const CLASSIFY_TIMEOUT_MS = 3_000
const CLASSIFY_CHARS = 4_000

function unquotedProse(text: string) {
  return text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\s*\1[^\n]*(?:\n|$)|(?![\s\S]))/gm, '')
    .replace(/^(?: {4}|\t|\s*>).*$/gm, '')
    .replace(/\*\*|__/g, '')
}

const stripQuotes = (text: string) =>
  text.replace(/`+[^`]*`+|"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]+'(?!\w)/g, '')

export function finalAsk(text: string) {
  const unquoted = unquotedProse(text)
  if (
    /(?:^|[.!?]\s+|\n)\s*(?:[-*]\s+)?(?:[^.!?\n,]{1,40},\s*|(?:just|then|so)\s+)?(?:say|give me (?:a|the|your)|tell me|reply(?: with)?)\s+["“‘'`]?go(?: ahead)?\b(?![-'’])/im.test(
      unquoted,
    )
  )
    return true
  const prose = stripQuotes(unquoted)
  const start = /(?:^|[.!]\s+|\n)\s*(?:[-*]\s+)?(?:[^:.!?\n]{1,40}:\s+)?/.source
  if (
    new RegExp(
      start +
        /(?:want me to\b|should I\b|(?:do you want|would you like|(?:can|could|would|will) you|are you ready|which (?:option|approach) do you|what would you prefer)\b)[^?\n]*\?/
          .source,
      'im',
    ).test(prose)
  )
    return true
  return new RegExp(
    start +
      /(?:let me know (?:which|whether|if (?:you(?:'d| would)? (?:like|want|prefer)|I should))|tell me (?:which|whether)|confirm and I)\b[^.!?\n]*[.!]?\s*$/
        .source,
    'i',
  ).test(prose.trimEnd())
}

export function finalAskState(text: string) {
  return unquotedProse(text).trim().slice(-CLASSIFY_CHARS)
}

async function classifiedAsk(host: ExtensionHost, text: string, signal: AbortSignal | undefined) {
  const classify = host.want(ClassifyApi)
  const state = finalAskState(text)
  if (!classify || !state) return false
  try {
    const deadline = AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)
    const timeout = new Promise<never>((_, reject) =>
      deadline.addEventListener('abort', () => reject(deadline.reason), { once: true }),
    )
    const result = await Promise.race([
      classify.ask(
        {
          state,
          questions: {
            ask: {
              type: 'noul',
              instructions:
                'Does this message end by asking the user for a go-ahead, choice or decision that it expects them to answer (not rhetorical, not a question it answers itself)?',
              criteria: {
                true: 'The closing lines ask the user to approve, choose or decide something before work continues, with or without a question mark.',
                false:
                  'It reports, concludes or states what happens next; any question is rhetorical, quoted, or answered in the message itself.',
              },
            },
          },
        },
        signal ? AbortSignal.any([signal, deadline]) : deadline,
      ),
      timeout,
    ])
    const answer = result.answers.ask
    return answer?.type === 'noul' && answer.noul >= FINAL_ASK_PROBABILITY
  } catch {
    return false
  }
}

const NUDGE =
  'Your final prose appears to ask the user for a decision, but it has no answer card. If a response is needed, send the actual question with message { to: "user", text, questions } using the appropriate question kinds and options. Otherwise state your conclusion without asking. Do not invent or answer a decision. This is the only corrective nudge for this run.'

export function finalAskNudge(host: ExtensionHost) {
  return hook(GenerationTask, {
    onYield: async (answer, api, ctx) => {
      const text = answer.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
      const matched = finalAsk(text)
      if (!matched && !host.want(ClassifyApi)) return undefined
      if (
        (await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate !== api.conversationId
      )
        return undefined
      const user = (await readSettings(userSettingsPath(host.userHome)).catch(meansNone)) ?? {}
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
      for (const id of run.inputs) {
        const input = await (await host.harness().submission(id, ctx))?.status(ctx)
        if (input?.type !== 'input' || input.status !== 'placed') return undefined
        if (input.requestId?.startsWith('watchdog-retry:')) return undefined
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
      if (!matched && !(await classifiedAsk(host, text, ctx.abortSignal))) return undefined
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
