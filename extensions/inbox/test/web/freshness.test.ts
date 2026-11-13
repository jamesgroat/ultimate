import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { InboxItem, InboxStatus } from '../../ui.tsx'
import type { Message } from '../../../messages/refs.ts'

const state = vi.hoisted(() => ({
  messages: [] as Message[] | undefined,
  statuses: [] as InboxStatus[],
  items: [] as InboxItem[],
}))
vi.mock('@/sdk', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  definePoint: (name: string) => ({ name }),
  defineWebExtension: (value: unknown) => value,
  provide: (point: unknown, use: unknown) => ({ point, use }),
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
          : [],
    ),
  api: {},
  events: { emit: () => {} },
  formatAgo: () => 'now',
  formatTime: () => 'today',
  Header: ({ children }: { children: ReactNode }) => h('header', null, children),
  Sidebar: () => null,
  useDocOf: (_id: number, doc: { kind: string }) =>
    doc.kind === 'messages'
      ? state.messages === undefined
        ? undefined
        : { messages: state.messages }
      : { items: [] },
  useEvent: () => {},
  useNow: () => 1000,
  useUltimate: () => ({ showSurface: () => {}, switchConversation: () => {} }),
  useViewport: () => 'desktop',
}))
vi.mock('../../../conversations/ui.tsx', () => ({
  FeatureTag: () => null,
  useOverview: () => ({}),
  useStandingName: () => undefined,
}))
vi.mock('../../../messages/ui.tsx', () => ({
  Body: () => null,
  emptyMessages: { messages: [] },
  MessageImages: () => null,
  MessagesDoc: { kind: 'messages' },
  stateTone: { waits: 'text-brand' },
}))
vi.mock('../../../questions/card.tsx', () => ({ MessageQuestions: () => null }))
vi.mock('../../../sidebar/ui.tsx', () => ({ UnderUltimate: {} }))
vi.mock('../../../subagents/ui.tsx', () => ({
  talkToUltimate: async () => undefined,
  StandingAction: {},
}))
import extension from '../../web.tsx'
import { Todos } from '../../../todos/panel.tsx'
import { inboxStatus } from '../../items.tsx'

const surface = () => renderToStaticMarkup(h(extension.surfaces![0].component))
const sidebar = () => renderToStaticMarkup((extension.provides![0].use as () => ReactNode)())
const todos = () => renderToStaticMarkup(h(Todos))
beforeEach(() => {
  state.messages = []
  state.statuses = []
  state.items = []
})

it('never claims all-clear until local readiness and every provider agree, across all shared counts', () => {
  state.messages = undefined
  expect(surface()).toContain('Inbox not up to date')
  expect(surface()).not.toContain('Every branch has what it needs.')
  expect(sidebar()).toContain('Inbox · ?')
  expect(todos()).toContain('? in Inbox')
  expect(todos()).not.toContain('Nothing open for you or @ultimate.')
  state.messages = []
  for (const status of ['loading', 'partial', 'error'] as const) {
    state.statuses = [{ state: status, text: 'Peer unavailable; waiting count unknown' }]
    expect(surface()).toContain('Peer unavailable; waiting count unknown')
    expect(sidebar()).toContain('Inbox · ?')
    expect(todos()).toContain('Peer unavailable; waiting count unknown')
    state.items = [
      {
        key: 'fleet:["peer",7]',
        at: 100,
        tag: 'question',
        title: 'Remote question',
        pane: 'Remote pane',
      },
    ]
    expect(surface()).toContain('Remote pane')
    expect(surface()).toContain('1+')
    expect(sidebar()).toContain('Inbox · 1+')
    expect(todos()).toContain('1+ in Inbox')
    state.items = []
  }
  state.statuses = [{ state: 'complete' }]
  expect(surface()).toContain('Every branch has what it needs.')
  expect(sidebar()).not.toContain('Inbox · ?')
  expect(todos()).toContain('Nothing open for you or @ultimate.')
  expect(
    inboxStatus(true, [{ state: 'loading' }, { state: 'partial' }, { state: 'error' }]).state,
  ).toBe('error')
})
