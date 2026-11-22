/** @jsxImportSource @solidjs/web */
import { expect, it, vi } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  Provided: () => null,
}))
vi.mock('../../../conversations/ui.solid.tsx', () => ({ ConversationRef: () => null }))
vi.mock('../../../questions/ui.solid.tsx', () => ({ MessageQuestions: () => null }))

import { Reading } from '../../reading.solid.tsx'

it('renders a link in the bold lead as a link in the heading, on one line', () => {
  const container = renderSolid(() => (
    <Reading
      entry={{
        key: 'message:1',
        at: 1,
        message: {
          id: 1,
          at: 1,
          from: 69 as ConversationId,
          to: 'user',
          text: '**Remove the throttle: [PR 1784](https://github.com/o/r/pull/1784)**\n\nBody',
          reply: true,
          state: 'delivered',
        },
      }}
      now={1000}
      onBack={() => {}}
      phone={false}
    />
  ))
  const heading = container.querySelector('[data-inbox-title]')!
  expect(heading.textContent).toBe('Remove the throttle: PR 1784')
  expect(heading.querySelectorAll('p')).toHaveLength(1)
  const link = heading.querySelector('[data-href], a[href]')!
  expect(link.textContent).toBe('PR 1784')
  expect(link.getAttribute('data-href') ?? link.getAttribute('href')).toBe(
    'https://github.com/o/r/pull/1784',
  )
})

it('names the original asker and chapter on a carried card', () => {
  const container = renderSolid(() => (
    <Reading
      entry={{
        key: 'message:1',
        at: 1,
        message: {
          id: 1,
          at: 1,
          from: 69 as ConversationId,
          to: 'user',
          text: 'Keep this?',
          reply: true,
          state: 'delivered',
          carried: { chapter: 'earlier', id: 42, from: 17 as ConversationId },
        },
      }}
      now={1000}
      onBack={() => {}}
      phone={false}
    />
  ))
  expect(container.querySelector('[data-inbox-carried]')?.textContent).toBe(
    'asked by #17 in earlier',
  )
})
