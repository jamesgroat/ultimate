import { expect, it } from 'vitest'
import { finalAsk, reportAsk } from '../nudge.ts'

it.each([
  'The build is ready. Say go when you want it.',
  'Say go when you want it',
  'Reply with go and I will push.',
  'Tell me go to start the rollout.',
  'Once the review is in, say **go** and I deploy.',
  'Just say "go" and I start.',
  'Done.\n- Say go ahead when ready.',
])('catches a go asked without a question mark: %s', (text) => {
  expect(finalAsk(text)).toBe(true)
})

it.each([
  'James said go on Nov 18, so I pushed.',
  'The go card is sent.',
  'Say goodbye to the old flag.',
  'Nothing more to say. Go reads the file at startup.',
  'Run `say go` in the terminal to test the voice.',
  '```\nsay go\n```',
  'They say go-live is Friday.',
])('leaves a go mention that asks nothing alone: %s', (text) => {
  expect(finalAsk(text)).toBe(false)
})

it('still catches question-mark asks', () => {
  expect(finalAsk('Want me to run the QA re-check now?')).toBe(true)
})

it.each([
  'Two options.\n- **Build now:** want me to go ahead with steps 1–3 (the parser and the card)?',
  'Plan is ready. Say go and I start the branch.',
  'Both work. Let me know which you prefer.',
  'The fix is staged. Tell me whether to push it.',
  'Review passed. Confirm and I land it.',
  'I can do either. Let me know if you would like the smaller one.',
])('catches a labelled or imperative ask: %s', (text) => {
  expect(finalAsk(text)).toBe(true)
})

it.each([
  'I will go ahead and land it now.',
  '> Should I keep the old flag?\nYes: I kept it, since two callers read it.',
  'You asked "should I keep the old flag?" and I kept it.',
  'Why not? The cache already holds it, so I reused it.',
  'Let me know if anything breaks; the change is live.',
  'Tell me which file broke and I will look, but nothing is pending now. Landed.',
])('leaves a statement, quote or rhetorical question alone: %s', (text) => {
  expect(finalAsk(text)).toBe(false)
})

it.each([
  "It's a plan only, with each step's side effects listed. Nothing gets deployed or run until you approve each step.",
  'Nothing merges or publishes until you approve that list on a card. The card asking whether to delete the old stack is still open.',
  'Nothing goes to the site until you approve merging the release PR.\n\nThe card for the rollout steps (message 463) is still waiting on your answer.',
  '#117998 is building the repo fix. It stops at a PR, and merging it needs your go.',
])('leaves a status report of a later approval alone: %s', (text) => {
  expect(finalAsk(text)).toBe(false)
})

it('sees a Decisions block anywhere in a report, spaced or not', () => {
  expect(reportAsk('Decisions:\n\n1. Build it.\n\n2. Should I run the focused check next?')).toBe(
    false,
  )
  expect(reportAsk('Decisions:\n1. Build it.\n2. Should I run the focused check next?')).toBe(false)
  expect(reportAsk('Built it.\n\nShould I run the focused check next?')).toBe(true)
})
