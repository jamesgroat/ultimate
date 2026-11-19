import { expect, it } from 'vitest'
import { finalAsk } from '../nudge.ts'

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
