import { expect, it, vi } from 'vitest'
import { inboxItems, itemKey, selection as choose } from '../../items.tsx'
import type { InboxItem } from '../../ui.tsx'
import type { Message } from '../../../messages/refs.ts'

// questions' ui.tsx also exports its answer card, whose imports need the running app.
vi.mock('../../../questions/card.tsx', () => ({ MessageQuestions: () => null }))

const ask = (id: number, at: number, fields: Partial<Message> = {}): Message => ({
  id,
  from: 40 + id,
  to: 'user',
  text: `Question ${id}`,
  at,
  reply: true,
  state: 'delivered',
  ...fields,
})

const selection = (items: readonly Message[], picked: number | null, index: number) =>
  choose(items, picked, index, (item) => item.id)

const log = [
  ask(1, 100),
  ask(2, 200, { state: 'answered' }),
  ask(3, 300),
  ask(4, 400, { reply: false }),
  ask(5, 500, { to: 7 }),
  ask(6, 600, { state: 'dismissed' }),
  ask(7, 700),
]

it('lists exactly the open questions to the user, oldest first', () => {
  expect(inboxItems(log).map((m) => m.id)).toEqual([1, 3, 7])
})

it('moves on to the next oldest when the shown item is answered', () => {
  const before = inboxItems(log)
  expect(selection(before, 3, 1)).toBe(3)
  const after = inboxItems(log.map((m) => (m.id === 3 ? { ...m, state: 'answered' as const } : m)))
  // Item 3 stood at index 1; item 7 now stands there.
  expect(selection(after, 3, 1)).toBe(7)
  // The newest answered: the one before it shows; the last answered: nothing.
  expect(selection(after, 7, 1)).toBe(7)
  expect(selection([after[0]], 7, 1)).toBe(1)
  expect(selection([], 1, 0)).toBeUndefined()
})

it('keeps provider selection separate across colliding local and peer message IDs', () => {
  const transport = { answer: async () => undefined, dismiss: async () => undefined }
  const local: InboxItem = { message: ask(1, 100) }
  const peer: InboxItem = {
    source: 'machine/project',
    sourceLabel: 'Project',
    sourceHref: 'https://project.example',
    message: ask(1, 200),
    transport,
  }
  const other: InboxItem = { ...peer, source: 'other/project' }
  const items = [local, peer, other]
  expect(new Set(items.map(itemKey)).size).toBe(3)
  expect(choose(items, null, 0, itemKey)).toBe(itemKey(local))
  expect(choose(items, itemKey(peer), 1, itemKey)).toBe(itemKey(peer))
  expect(choose([other, local, peer], itemKey(peer), 1, itemKey)).toBe(itemKey(peer))
  expect(choose([local, other], itemKey(peer), 1, itemKey)).toBe(itemKey(other))
  const moved = { ...peer, sourceHref: 'https://new-address.example' }
  expect(itemKey(moved)).toBe(itemKey(peer))
  expect(peer.message.id).toBe(local.message.id)
})
