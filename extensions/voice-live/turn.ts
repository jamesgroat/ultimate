export type VoiceTurns = 'auto' | 'dictation'

export const END_PHRASES = ['over', 'go ahead', 'send it', 'done']
export const WAIT_PHRASES = ['wait', 'hold on', 'hang on', 'let me think', 'one sec', 'one second']
export const WAIT_MS = 30_000
export const DICTATION_MS = 30_000
export const SURE = 0.9
export const SOFT_MS = 4000

const TRAILING = new Set(
  (
    'a an the to of in on at for with about from into onto by as than and or but nor so because if that which who ' +
    'whom whose where when while whether although though unless until like then is are was were be been being am ' +
    'do does did have has had can could would should will shall may might must gonna wanna gotta i we they he she ' +
    "my your our their its i'm we're they're it's there's um uh er erm hmm basically actually just really also maybe"
  ).split(' '),
)
const SHORT = new Set(
  (
    'yes yeah yep no nope ok okay sure thanks thank you hi hello hey stop cancel never mind go on right exactly ' +
    'good great cool perfect fine bye goodbye correct'
  ).split(' '),
)
const ING_NOUNS = new Set(
  (
    'thing something nothing anything everything morning evening building string ring king spring ceiling meeting ' +
    'setting timing wedding ping warning heading thinking feeling during ending beginning pricing billing logging ' +
    'tracking routing caching testing hosting'
  ).split(' '),
)
const COMPOSING =
  /\b(?:function|variable|const|return|import|class|method|parameter|argument|bracket|parenthes[ie]s|semicolon|equals|string|array|object|file|line \d+|regex|commit|branch named)\b/i

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
const phrase = (list: string[]) =>
  new RegExp(
    `(^|[.,!?;:…]\\s*)(?:${list.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})[\\s.,!?…]*$`,
    'i',
  )

export function endsWith(text: string, list: string[]) {
  if (!list.length) return undefined
  const match = phrase(list).exec(text.trim())
  if (!match) return undefined
  return text
    .trim()
    .slice(0, match.index + match[1].length)
    .trim()
    .replace(/[,;:]$/, '')
}

export function modeSwitch(text: string): VoiceTurns | undefined {
  const match =
    /^(?:(?:switch|go|change)\s+(?:to|into)\s+|use\s+|turn\s+on\s+)?(dictation|normal|auto)\s+mode[.!]?$/i.exec(
      text.trim(),
    )
  if (!match) return undefined
  return match[1].toLowerCase() === 'dictation' ? 'dictation' : 'auto'
}

export function doubt(text: string): { why: string; soft?: true } | undefined {
  const trimmed = text.trim()
  const all = words(trimmed)
  if (!all.length) return { why: 'empty' }
  if (!/[.?!…]["')\]]*$/.test(trimmed)) return { why: 'no end punctuation' }
  const last = all.at(-1)!
  if (TRAILING.has(last)) return { why: `ends on "${last}"` }
  if (last.length > 4 && last.endsWith('ing') && !ING_NOUNS.has(last))
    return { why: `ends on "${last}"` }
  if (all.length > 25) return { why: 'a long, composed line' }
  if (COMPOSING.test(trimmed)) return { why: 'composing' }
  if (
    all.length <= 3 &&
    !SHORT.has(all.join(' ')) &&
    !all.every((word) => SHORT.has(word)) &&
    !trimmed.endsWith('?')
  )
    return { why: 'a short fragment', soft: true }
  return undefined
}

export type Turn =
  | { kind: 'send'; text: string; why: string }
  | { kind: 'hold'; text: string; ms: number; why: string }
  | { kind: 'mode'; turns: VoiceTurns }

export function decide(
  text: string,
  smart: { complete?: boolean; probability?: number },
  options: { turns: VoiceTurns; holdMs: number; endPhrases: string[] },
): Turn {
  const turns = modeSwitch(text)
  if (turns) return { kind: 'mode', turns }
  const ended = endsWith(text, options.endPhrases)
  if (ended !== undefined) return { kind: 'send', text: ended, why: 'end phrase' }
  const waited = endsWith(text, WAIT_PHRASES)
  if (waited !== undefined) return { kind: 'hold', text: waited, ms: WAIT_MS, why: 'asked to wait' }
  if (options.turns === 'dictation')
    return { kind: 'hold', text, ms: DICTATION_MS, why: 'dictation' }
  const found = doubt(text)
  if (found && !found.soft) return { kind: 'hold', text, ms: options.holdMs, why: found.why }
  if (smart.complete === false)
    return {
      kind: 'hold',
      text,
      ms: options.holdMs,
      why: `Smart Turn ${smart.probability ?? 'unfinished'}`,
    }
  const short = Math.min(SOFT_MS, options.holdMs)
  if (found) return { kind: 'hold', text, ms: short, why: found.why }
  if ((smart.probability ?? 1) < SURE)
    return { kind: 'hold', text, ms: short, why: `Smart Turn unsure ${smart.probability}` }
  return { kind: 'send', text, why: 'finished' }
}
