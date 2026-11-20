/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { act, createContext, createElement as h } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { Message } from '../../../messages/refs.ts'
import type { InboxItem, InboxStatus } from '../../ui.tsx'

const state = vi.hoisted(() => ({
  messages: undefined as Message[] | undefined,
  statuses: [] as InboxStatus[],
  items: [] as InboxItem[],
  source: 'Peer',
}))
vi.mock('../../../../web/src/sdk/hooks.ts', () => ({ ExtensionNameContext: createContext(null) }))
vi.mock('../../../../web/src/sdk/conversation-scope.tsx', () => ({
  ConversationIdContext: createContext(null),
}))
vi.mock('@/sdk', async () => ({
  island: (await import('../../../../web/src/sdk/island.tsx')).island,
  ROOT: 1,
  definePoint: (name: string) => ({ name }),
  defineWebExtension: (value: unknown) => value,
  provide: (point: unknown, use: unknown) => ({ point, use }),
  Provided: ({ children }: { children: (value: undefined) => ReactNode }) => children(undefined),
  AllProvided: ({
    point,
    children,
  }: {
    point: { name: string }
    children: (values: unknown[]) => ReactNode
  }) =>
    children(
      point.name === 'inbox.items'
        ? [state.items]
        : point.name === 'inbox.freshness'
          ? state.statuses
          : [h('span', { key: 'peer', 'data-inbox-source': 'peer' }, state.source)],
    ),
  Header: ({ children }: { children: ReactNode }) => h('header', null, children),
  Sidebar: () => null,
  useDocOf: () => (state.messages === undefined ? undefined : { messages: state.messages }),
  useNow: () => 1000,
  useUltimate: () => ({ surface: 'inbox' }),
  useViewport: () => 'desktop',
}))
vi.mock('@/sdk/solid', async () => {
  const { createContext: solidContext } = await import('solid-js')
  const { cn } = await import('cn')
  return {
    cn,
    ExtensionName: solidContext(null),
    ConversationScope: solidContext(null),
    ROOT: 1,
    api: {},
    events: { emit: () => {} },
    formatAgo: () => 'now',
    formatTime: () => 'today',
    useNow: () => () => 1000,
    useUiState: () => [() => null, () => {}],
    useExtensionUiState: (_key: string, initial: unknown) => [() => initial, () => {}],
    useDocOf: () => () => ({ items: [] }),
    showSurface: () => {},
    switchConversation: () => {},
    writingAs: (_source: string, run: () => void) => run(),
  }
})
vi.mock('../../../conversations/ui.solid.tsx', () => ({ ConversationRef: () => null }))
vi.mock('../../../messages/ui.tsx', () => ({
  emptyMessages: { messages: [] },
  MessagesDoc: { kind: 'messages' },
}))
vi.mock('../../../sidebar/ui.tsx', () => ({ UnderUltimate: {} }))
vi.mock('../../reading.tsx', () => ({
  Reading: ({ entry }: { entry: { item: InboxItem } }) => entry.item.pane,
}))
vi.mock('../../selection.tsx', () => ({
  useSelection: (entries: unknown[]) => ({
    shown: entries[0],
    selected: null,
    setSelected: () => {},
  }),
}))
vi.mock('../../../todos/call.tsx', () => ({ TodoCall: () => null }))

import extension from '../../web.tsx'
import todos from '../../../todos/web.tsx'
import { inboxStatus } from '../../items.ts'

it('never claims all-clear until Messages and every provider are ready, across React and Solid counts and chips', async ({
  onTestFinished,
}) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  const render = async () => {
    await act(async () => {
      root.render(
        h(
          'div',
          null,
          h(extension.surfaces![0].component),
          h('aside', null, (extension.provides![0].use as () => ReactNode)()),
          h('div', { 'data-badge': true }, h(extension.surfaces![0].badge!)),
          h(todos.panels![0].component),
        ),
      )
      await settle()
      flush()
    })
  }
  const text = (selector: string) => container.querySelector(selector)?.textContent ?? ''
  await render()
  expect(text('[data-inbox-zero]')).toContain('Inbox not up to date')
  expect(text('main')).not.toContain('Every branch has what it needs.')
  expect(text('header')).toContain('?')
  expect(text('aside')).toContain('Inbox · ?')
  expect(text('[data-badge]')).toBe('?')
  expect(text('[data-todos]')).toContain('? in Inbox')
  expect(text('[data-todos]')).not.toContain('Nothing open for you or @ultimate.')

  state.messages = []
  for (const status of ['loading', 'partial', 'error'] as const) {
    state.statuses = [{ state: status, text: 'Peer unavailable; waiting count unknown' }]
    await render()
    expect(text('[data-inbox-zero]')).toContain('Peer unavailable; waiting count unknown')
    expect(text('aside')).toContain('Inbox · ?')
    expect(text('[data-todo-inbox]')).toContain('Peer unavailable; waiting count unknown')
    state.items = [
      {
        key: 'fleet:peer:7',
        at: 100,
        tag: 'question',
        title: 'Remote question',
        pane: 'Remote pane',
      },
    ]
    await render()
    expect(text('main')).toContain('Remote pane')
    expect(text('main > [role="status"]')).toBe('Peer unavailable; waiting count unknown')
    expect(text('header')).toContain('1+')
    expect(text('.section-label')).toContain('1+')
    expect(text('aside')).toContain('Inbox · 1+')
    expect(text('[data-badge]')).toBe('1+')
    expect(container.querySelector('[data-badge] span')?.getAttribute('title')).toBe(
      state.statuses[0].text,
    )
    expect(text('[data-todos]')).toContain('1+ in Inbox')
    expect(text('[data-todo-inbox]')).toContain('Inbox · 1+')
    expect(text('[data-inbox-row] [data-inbox-source]')).toBe(state.source)
    state.source = `${status} peer`
    await render()
    expect(text('[data-inbox-row] [data-inbox-source]')).toBe(state.source)
    state.items = []
    await render()
    expect(container.querySelector('[data-inbox-source]')).toBeNull()
  }
  state.statuses = [{ state: 'complete' }]
  await render()
  expect(text('[data-inbox-zero]')).toContain('Every branch has what it needs.')
  expect(text('aside')).not.toContain('Inbox · ?')
  expect(text('[data-badge]')).toBe('')
  expect(text('[data-todos]')).toContain('Nothing open for you or @ultimate.')
  expect(
    inboxStatus(true, [{ state: 'loading' }, { state: 'partial' }, { state: 'error' }]).state,
  ).toBe('error')
})
