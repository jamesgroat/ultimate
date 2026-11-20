import type { NoticeClass } from './episodes.ts'
const ACCOUNT_URLS: Record<string, string> = {
  'claude-code': 'https://claude.ai/settings/usage',
  anthropic: 'https://console.anthropic.com/settings/billing',
  'openai-codex': 'https://chatgpt.com/codex/settings/usage',
  openai: 'https://platform.openai.com/settings/organization/billing',
  openrouter: 'https://openrouter.ai/settings/credits',
  typesafe: 'https://console.typesafe.ai',
}
const KNOWN_CONSUMERS: Record<string, string[]> = {
  typesafe: ['classify (phase, recall, the final-ask classifier)'],
}

const HEADLINES: Record<NoticeClass, string> = {
  billing: 'out of credits',
  usage: 'usage limit reached',
  auth: 'key rejected',
}

export type NoticeInput = {
  provider: string
  name: string
  class: NoticeClass
  resetsAt?: number
  agents: string[]
  timeZone?: string
}

const time = (at: number, timeZone?: string) =>
  new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone })

export function noticeFor(input: NoticeInput) {
  const reset = input.resetsAt ? time(input.resetsAt, input.timeZone) : undefined
  const title = `${input.name}: ${HEADLINES[input.class]}${reset ? ` (resets ${reset})` : ''}`
  const blocked = [
    ...input.agents.map((agent) => `the ${agent} agent`),
    ...(KNOWN_CONSUMERS[input.provider] ?? []),
  ]
  const url = ACCOUNT_URLS[input.provider]
  const lines = [
    blocked.length
      ? `Every call to ${input.name} fails, so ${list(blocked)} cannot run on it.`
      : `Every call to ${input.name} fails.`,
    input.class === 'usage'
      ? reset
        ? `The limit resets at ${reset}${dayOf(input.resetsAt!, input.timeZone)}.`
        : 'The provider did not say when the limit resets.'
      : input.class === 'billing'
        ? `Add credits${url ? ` at ${url}` : ''}.`
        : `Log in again: ⌘K → Log in to a provider${url ? `, or check the key at ${url}` : ''}.`,
    ...(input.class === 'usage' && url ? [`Usage: ${url}`] : []),
    'This stays the one notice until a call succeeds again.',
  ]
  return { title, text: lines.join('\n\n') }
}

function dayOf(at: number, timeZone?: string) {
  const day = (when: number) => new Date(when).toLocaleDateString('en-US', { timeZone })
  return day(at) === day(Date.now())
    ? ''
    : ` on ${new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone })}`
}

function list(items: string[]) {
  return items.length < 3
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
