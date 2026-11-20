import { settle } from '@ui-sdk/core/testing'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import type { Entry } from '../../items.ts'
import type { InboxItem, InboxStatus } from '../../ui.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { FakeSource, fakeSubscriptions } = await import('../../../../test/web/fake-source.ts')
  const subscriptions = fakeSubscriptions(harness.sources)
  harness.server = subscriptions
  return {
    store: createStore({
      eventSource: (url) => {
        const source = new FakeSource(url)
        harness.sources.push(source)
        return source
      },
      fetch: async (input, init) =>
        subscriptions.handle(input as string, init) ?? Response.json({}),
    }),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
  }
})
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  Header: (props: { children: import('@solidjs/web').JSX.Element }) => (
    <header>{props.children}</header>
  ),
  Sidebar: () => null,
  useViewport: () => () => 'desktop',
}))
vi.mock('../../../conversations/ui.solid.tsx', () => ({ ConversationRef: () => null }))

import { store, registry } from '../../../../web/src/sdk/client.ts'
import { ExtensionName, provide } from '@/sdk/solid'
import { Inbox, InboxSidebar, WaitingBadge } from '../../surface.solid.tsx'
import { InboxFreshness, InboxItems, InboxSourceChip } from '../../ui.solid.tsx'
import { inboxStatus } from '../../items.ts'
import { TodoList } from '../../../todos/panel.solid.tsx'

it('keeps incomplete counts and warnings until every source is fresh and renders live Solid source chips', async ({
  onTestFinished,
}) => {
  const [status, setStatus] = createSignal<InboxStatus>({ state: 'loading' })
  const [items, setItems] = createSignal<InboxItem[]>([])
  const [source, setSource] = createSignal('Peer')
  await registry.setLoaders({
    'extensions/peer/web.solid.tsx': async () => ({
      default: {
        provides: [
          provide(InboxItems, () => items),
          provide(InboxFreshness, () => status),
          provide(InboxSourceChip, (props: Entry) => (
            <span data-inbox-source={props.key}>{source()}</span>
          )),
        ],
      },
    }),
  })
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  const container = renderSolid(() => (
    <ExtensionName value="inbox">
      <Inbox />
      <aside>
        <InboxSidebar />
      </aside>
      <div data-badge>
        <WaitingBadge />
      </div>
      <TodoList />
    </ExtensionName>
  ))
  await settle()
  const text = (selector: string) => container.querySelector(selector)?.textContent ?? ''
  expect(text('[data-inbox-zero]')).toContain('Inbox not up to date')
  expect(text('header')).toContain('?')
  expect(text('[data-todos]')).not.toContain('Nothing open for you or @ultimate.')
  harness.server!.of(1)!.send('doc', { kind: 'board', value: { next: 1, messages: [] } })
  setStatus({ state: 'complete' })
  flush()
  await settle()
  expect(text('[data-inbox-zero]')).toContain('Every branch has what it needs.')
  for (const state of ['loading', 'partial', 'error'] as const) {
    setSource('Peer')
    setStatus({ state, text: 'Peer unavailable; waiting count unknown' })
    flush()
    expect(text('aside')).toContain('Inbox · ?')
    expect(text('[data-todo-inbox]')).toContain('Peer unavailable; waiting count unknown')
    setItems([
      { key: 'peer:7', at: 100, tag: 'question', title: 'Remote question', pane: 'Remote pane' },
    ])
    flush()
    await settle()
    expect(text('main')).toContain('Remote pane')
    expect(text('main > output')).toBe('Peer unavailable; waiting count unknown')
    expect(text('header')).toContain('1+')
    expect(text('.section-label')).toContain('1+')
    expect(text('aside')).toContain('Inbox · 1+')
    expect(text('[data-badge]')).toBe('1+')
    expect(text('[data-todos]')).toContain('1+ in Inbox')
    expect(text('[data-inbox-row] [data-inbox-source]')).toBe('Peer')
    setSource(`${state} peer`)
    flush()
    expect(text('[data-inbox-row] [data-inbox-source]')).toBe(`${state} peer`)
    setItems([])
    flush()
    expect(container.querySelector('[data-inbox-source]')).toBeNull()
  }
  setStatus({ state: 'complete' })
  flush()
  expect(text('[data-badge]')).toBe('')
  expect(text('[data-todos]')).toContain('Nothing open for you or @ultimate.')
  expect(
    inboxStatus(true, [{ state: 'loading' }, { state: 'partial' }, { state: 'error' }]).state,
  ).toBe('error')
})
