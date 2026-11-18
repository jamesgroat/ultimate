import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  landers: [
    { id: 2, label: 'lander' },
    { id: 3, label: 'lander' },
  ],
}))
vi.mock('@/sdk', async (original) => ({
  ...(await original<typeof import('@/sdk')>()),
  useDocOf: () => undefined,
  useTasks: () => undefined,
  useStore: () => undefined,
  useSystem: () => undefined,
  useNow: () => 1000,
  Provided: ({ children }: { children: (value: undefined) => unknown }) => children(undefined),
  AllProvided: ({ children }: { children: (value: []) => unknown }) => children([]),
  Slot: () => null,
}))
vi.mock('@/sdk/client', () => ({ store: {}, reads: {}, api: {} }))
vi.mock('@/sdk/resume', () => ({ resumed: false, covered: () => false }))
vi.mock('../../../conversations/ui.tsx', async (original) => ({
  ...(await original<typeof import('../../../conversations/ui.tsx')>()),
  useOverview: () => ({}),
  useConcludedSince: () => () => undefined,
  useAgentTitle: (name: string) => ({ title: name === 'lander' ? 'Lander' : name }),
  AgentMark: () => null,
}))
vi.mock('../../../workspaces/ui.tsx', async (original) => ({
  ...(await original<typeof import('../../../workspaces/ui.tsx')>()),
  useWorkspaceConversations: () => fixture.landers,
  useWorkspaceIndex: () => ({
    items: {},
    queue: [],
    results: {},
    landerConversations: { '/projects/app': 2, '/projects/engine': 3 },
  }),
}))
vi.mock('../../../messages/ui.tsx', async (original) => ({
  ...(await original<typeof import('../../../messages/ui.tsx')>()),
  useStarters: () => () => undefined,
  useUnderway: () => () => false,
  useRemoteProgress: () => ({}),
}))
vi.mock('../../../automations/ui.tsx', () => ({
  useAutomations: () => ({}),
  timerWaits: () => [],
}))
vi.mock('../../../lineage/ui.tsx', async (original) => ({
  ...(await original<typeof import('../../../lineage/ui.tsx')>()),
  useRoots: () => [],
}))
vi.mock('../../state.tsx', () => ({
  useShell: () => ({ surface: 'agent' }),
  useSidebarState: (_key: string, initial: unknown) => [initial, () => {}],
}))
vi.mock('../../project.tsx', () => ({ Project: () => null }))
vi.mock('../../root.tsx', () => ({ InFlight: () => null }))
vi.mock('../../ultimate.tsx', () => ({
  WaitingOnUser: ({ children }: { children: (count: number) => unknown }) => children(0),
}))
vi.mock('../../landed.tsx', () => ({
  useLandings: () => [],
  Landed: () => createElement('section', { 'aria-label': 'Landed' }, 'Recent feature'),
}))

const { Conversations } = await import('../../sidebar.tsx')

it('keeps repository-labelled landers and renders their combined history only once', () => {
  const html = renderToStaticMarkup(createElement(Conversations))
  expect(html.match(/data-standing="lander"/g)).toHaveLength(2)
  expect(html).toContain('title="/projects/app">app</span>')
  expect(html).toContain('title="/projects/engine">engine</span>')
  expect(html.match(/aria-label="Landed"/g)).toHaveLength(1)
  expect(html.indexOf('data-conversation="3"')).toBeLessThan(html.indexOf('aria-label="Landed"'))
})
