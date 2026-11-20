import {
  defineDoc,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, SubmissionId, TaskId } from '@earendil-works/pi-durable'
import { meansNone } from '../../lib/errors.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Messages, Started } from '../messages/api.ts'
import type { Message } from '../messages/api.ts'
import { Standing } from '../subagents/api.ts'
import { Branch } from '../lineage/api.ts'
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
const TAIL_CHARS = 800
const HEAD_CHARS = 200

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

const DECISIONS_BLOCK = /(?:^|\n)\s*(?:\*\*)?Decisions:|\bMy picks?:/i
const VERDICT = /^\s*(?:\*\*)?(?:ask the user|decided:|hold\b)/i
const POINTS_AT_CARD = /\bcard\b|\bInbox\b|\bmessage \d+/i
const PROSE_DECISION =
  /decision needed|\bneeds?\b[^.\n]{0,40}\b(?:a|your|his|her|their|the user's|separate|explicit)\s+go\b|\bneeds?\b[^.\n]{0,40}\b\w+'s go\b|\b(?:wait|waits|waiting) (?:on|for) (?:the user|you|him|her|\w+'s)\b[^.\n]{0,20}\b(?:go|answer|decision)\b|^\s*(?:do|shall|can) I\b[^?\n]*\?/im

const pointsAtCard = (text: string) => POINTS_AT_CARD.test(finalAskState(text)?.tail ?? '')

export function reportAsk(text: string) {
  const tail = finalAskState(text)?.tail ?? ''
  const prose = unquotedProse(text)
  if (DECISIONS_BLOCK.test(prose) || VERDICT.test(prose) || pointsAtCard(text)) return false
  return finalAsk(text) || PROSE_DECISION.test(stripQuotes(tail))
}

export function finalAskState(
  text: string,
): { head: string; tail: string } | { tail: string } | undefined {
  const paragraphs = unquotedProse(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const tail = paragraphs.slice(-2).join('\n\n').slice(-TAIL_CHARS)
  if (!tail) return undefined
  return paragraphs.length > 2 ? { head: paragraphs[0].slice(0, HEAD_CHARS), tail } : { tail }
}

function withDeadline<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
) {
  const deadline = AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)
  const timeout = new Promise<never>((_, reject) =>
    deadline.addEventListener('abort', () => reject(deadline.reason), { once: true }),
  )
  return Promise.race([run(signal ? AbortSignal.any([signal, deadline]) : deadline), timeout])
}

export const COVERED_OVERLAP = 0.3
const FILLER = new Set(
  'the and for with that this from into onto about your you yours are was were will would should could can may might must have has had not but all any its it’s our out then than them they there these those what which whether when where who how why want like let know tell say said give just also now wait until before after only one two more most some such very here ready okay ok please me my mine shall does did done do yes no go ahead'.split(
    ' ',
  ),
)

const contentWords = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !FILLER.has(word)),
  )

export function overlap(a: string, b: string) {
  const left = contentWords(a)
  const right = contentWords(b)
  const shared = [...left].filter((word) => right.has(word)).length
  const union = left.size + right.size - shared
  return union ? shared / union : 0
}

const cardText = (message: Message) =>
  [message.text, ...(message.questions ?? []).map((q) => q.text)].join('\n')

async function coveringCards(
  host: ExtensionHost,
  text: string,
  cards: Message[],
  signal: AbortSignal | undefined,
) {
  const tail = finalAskState(text)?.tail ?? ''
  const classify = host.want(ClassifyApi)
  if (classify && tail) {
    try {
      const result = await withDeadline(signal, (abort) =>
        classify.ask(
          {
            state: { tail, cards: Object.fromEntries(cards.map((m) => [m.id, cardText(m)])) },
            questions: Object.fromEntries(
              cards.map((m) => [
                `card${m.id}`,
                {
                  type: 'noul' as const,
                  instructions: `\`tail\` is the closing part of an AI assistant's final reply; \`cards.${m.id}\` is a question card it already sent the user and that is still unanswered. Does that card already ask the user the same decision as the closing text?`,
                  criteria: {
                    true: 'Answering the card settles what the closing text asks.',
                    false: 'The closing text asks about something the card does not decide.',
                  },
                },
              ]),
            ),
          },
          abort,
        ),
      )
      return new Set(
        cards
          .filter((m) => {
            const answer = result.answers[`card${m.id}`]
            return answer?.type === 'noul' && answer.noul >= FINAL_ASK_PROBABILITY
          })
          .map((m) => m.id),
      )
    } catch {
      return overlapping(tail, cards)
    }
  }
  return overlapping(tail || text, cards)
}

function overlapping(text: string, cards: Message[]) {
  return new Set(
    cards.filter((m) => overlap(text, cardText(m)) >= COVERED_OVERLAP).map((m) => m.id),
  )
}

async function classifiedAsk(host: ExtensionHost, text: string, signal: AbortSignal | undefined) {
  const classify = host.want(ClassifyApi)
  const state = finalAskState(text)
  if (!classify || !state) return false
  try {
    const result = await withDeadline(signal, (abort) =>
      classify.ask(
        {
          state,
          questions: {
            ask: {
              type: 'noul',
              instructions:
                "`tail` is the closing part of an AI assistant's final reply to its user (`head` is how the reply began). Does it leave the next step waiting on the user: asking them to choose, approve, confirm or say go, or offering to proceed only if they say so ('if you give me the go', 'happy to start whenever you want', 'your call')? Rhetorical questions, quoted earlier questions, conditional statements of fact, and plans the assistant will carry out without an answer do not count.",
              criteria: {
                true: 'The next step waits on the user: it asks them to choose, approve, confirm or say go, or offers to proceed only once they say so, with or without a question mark.',
                false:
                  'It reports results or states what the assistant will do next without needing an answer; any question is rhetorical, quoted or answered in the reply itself.',
              },
            },
          },
        },
        abort,
      ),
    )
    const answer = result.answers.ask
    return answer?.type === 'noul' && answer.noul >= FINAL_ASK_PROBABILITY
  } catch {
    return false
  }
}

const NUDGE =
  'Your final prose appears to ask the user for a decision, but it has no answer card. If a response is needed, send the actual question with message { to: "user", text, questions } using the appropriate question kinds and options. Otherwise state your conclusion without asking. Do not invent or answer a decision. This is the only corrective nudge for this run.'

const REPORT_NUDGE =
  'Your final prose appears to leave a decision for the user, but it has no answer card. If a branch asks for one, answer it with your verdict (ask the user with your picks, decided, or hold), or send the actual question with message { to: "user", text, questions }. Otherwise state your conclusion without asking. Do not invent or answer a decision. This is the only corrective nudge for this run.'

const BRANCH_NUDGE =
  'Your final answer appears to leave a decision for the user in prose. If one is needed, end with a Decisions: block for @ultimate (one numbered line per decision with lettered options, then My picks), or, if @ultimate already said to ask the user, send the card with message { to: "user", text, questions }. Otherwise state your conclusion without asking. Do not invent or answer a decision. This is the only corrective nudge for this run.'

type Scope = 'user' | 'report' | 'branch'

export function finalAskNudge(host: ExtensionHost) {
  return hook(GenerationTask, {
    onYield: async (answer, api, ctx) => {
      const text = answer.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
      const matched = finalAsk(text)
      const reported = reportAsk(text)
      if (!matched && !reported && !host.want(ClassifyApi)) return undefined
      const primary =
        (await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate === api.conversationId
      const branch = async (id: unknown) =>
        typeof id === 'number' &&
        (await api.snapshot(Branch, id as ConversationId, ctx))?.branch !== undefined
      if (!primary && !(await branch(api.conversationId))) return undefined
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
      let scope: Scope = primary ? 'user' : 'branch'
      const starter = primary
        ? undefined
        : (await api.snapshot(Started, api.conversationId, ctx))?.by
      for (const id of run.inputs) {
        const input = await (await host.harness().submission(id, ctx))?.status(ctx)
        if (input?.type !== 'input' || input.status !== 'placed') return undefined
        if (input.requestId?.startsWith('watchdog-retry:')) return undefined
        const entry = await api.entry(input.entry, ctx)
        const from = (entry?.data as { from?: unknown } | undefined)?.from
        const delivered = entry?.kind === 'board.message' || entry?.kind === 'board.reply'
        const fromUser =
          entry?.kind === 'pi.user' ||
          entry?.kind === 'voice.utterance' ||
          (entry?.kind === 'board.message' && from === 'user')
        if (!primary) {
          if (!fromUser && !(delivered && starter !== undefined && from === starter))
            return undefined
          continue
        }
        if (delivered && (await branch(from))) scope = 'report'
        else if (!fromUser) return undefined
      }
      if (scope === 'user') {
        if (!matched && !(await classifiedAsk(host, text, ctx.abortSignal))) return undefined
      } else if (!reported) return undefined
      const open = (
        (await api.snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages ?? []
      ).filter((m) => m.from === api.conversationId && openQuestion(m))
      const covered = open.length
        ? await coveringCards(host, text, open, ctx.abortSignal)
        : new Set<number>()
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
            (m) => m.from === api.conversationId && openQuestion(m) && covered.has(m.id),
          )
        )
          return false
        const attempt = await tx.doc(Attempt, api.conversationId)
        if (attempt.run === run.inputs[0]) return attempt.generation === api.taskId
        attempt.run = run.inputs[0]
        attempt.generation = api.taskId
        return true
      }, ctx)
      if (!claimed) return undefined
      return {
        continue: scope === 'branch' ? BRANCH_NUDGE : scope === 'report' ? REPORT_NUDGE : NUDGE,
      }
    },
  })
}
