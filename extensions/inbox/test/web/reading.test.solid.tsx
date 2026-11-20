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
