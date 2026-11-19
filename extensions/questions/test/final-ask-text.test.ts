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
