import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionRecord } from '../../../../web/src/sdk/registry.ts'
import type { Message } from '../../../messages/refs.ts'
import type { InboxBoard } from '../../../inbox/ui.tsx'

const state = vi.hoisted(() => ({
  messages: [] as Message[],
  records: [] as ExtensionRecord[],
  surface: '',
}))
vi.mock('../../../../web/src/sdk/hooks.ts', async () => ({
  ExtensionNameContext: (await import('react')).createContext<string | undefined>(undefined),
  useExtensions: () => state.records,
  useSystem: () => undefined,
}))
vi.mock('@/sdk', async () => ({
  ...(await import('../../../../web/src/sdk/types.ts')),
  Provided: (await import('../../../../web/src/app/boundary.tsx')).Provided,
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  defineWebExtension: (extension: unknown) => extension,
  events: { emit: () => {} },
  api: {},
  formatAgo: (at: number) => `${at}m`,
  formatTime: () => 'today',
  Header: ({ children }: { children: ReactNode }) => h('header', null, children),
  Sidebar: () => null,
  useDocOf: (_id: number, doc: { kind: string }) =>
    doc.kind === 'messages' ? { messages: state.messages } : { items: [] },
  useEvent: () => {},
  useNow: () => 1000,
  useUltimate: () => ({
    showSurface: (surface: string) => {
      state.surface = surface
    },
  }),
  useViewport: () => 'desktop',
}))
vi.mock('../../../messages/ui.tsx', () => ({
  emptyMessages: { messages: [] },
  MessagesDoc: { kind: 'messages' },
  stateTone: { waits: 'text-brand' },
  Body: () => null,
  MessageImages: () => null,
}))
vi.mock('../../../questions/card.tsx', () => ({ MessageQuestions: () => null }))
vi.mock('../../../conversations/ui.tsx', async () => ({
  featureHue: (await import('../../../conversations/feature.tsx')).featureHue,
  FeatureTag: () => null,
  useOverview: () => ({}),
  useStandingName: () => undefined,
}))
vi.mock('../../../sidebar/ui.tsx', () => ({ UnderUltimate: { point: 'sidebar.under-ultimate' } }))
vi.mock('../../../subagents/ui.tsx', () => ({ StandingAction: {}, talkToUltimate: () => {} }))
import inbox from '../../../inbox/web.tsx'
import { InboxSource } from '../../../inbox/ui.tsx'
import { Todos } from '../../panel.tsx'

const ask = (id: number, at: number): Message => ({
  id,
  from: 42,
  to: 'user',
  text: `Question ${id}`,
  at,
  reply: true,
  state: 'delivered',
})
const render = () => {
  const sidebar = inbox.provides![0].use(null as never) as ReactNode
  return {
    sidebar: renderToStaticMarkup(sidebar),
    todos: renderToStaticMarkup(h(Todos)),
  }
}

beforeEach(() => {
  state.messages = [ask(1, 200), { ...ask(2, 100), state: 'answered' }]
  state.records = []
})

it('keeps the local-only To-dos Inbox count equal to the sidebar', () => {
  const { sidebar, todos } = render()
  expect(sidebar).toContain('Inbox · 1')
  expect(sidebar).toContain('oldest 200m')
  expect(todos).toMatch(/Inbox · (?:<!-- -->)?1/)
  expect(todos).toContain('1 question')
})

it('uses the augmented board for both counts and the oldest wait, including peer-only items', () => {
  const peer = {
    source: 'machine/project',
    sourceLabel: 'Peer',
    message: ask(1, 50),
    transport: { answer: async () => undefined, dismiss: async () => undefined },
  }
  state.records = [
    {
      name: 'source',
      version: 1,
      loading: false,
      extension: {
        provides: [
          {
            point: InboxSource.point,
            use: (local: InboxBoard) => ({
              ...local,
              items: [...local.items, peer],
            }),
          },
        ],
      },
    },
  ]
  const both = render()
  expect(both.sidebar).toContain('Inbox · 2')
  expect(both.sidebar).toContain('oldest 50m')
  expect(both.todos).toMatch(/Inbox · (?:<!-- -->)?2/)
  expect(both.todos).toContain('2 questions')
  state.messages = []
  const remoteOnly = render()
  expect(remoteOnly.sidebar).toContain('Inbox · 1')
  expect(remoteOnly.todos).toMatch(/Inbox · (?:<!-- -->)?1/)
  expect(remoteOnly.todos).not.toContain('Nothing open for you')
})
