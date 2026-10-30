import { createElement as h, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EntryRecord } from '../../web/src/sdk/index.ts'

const harness = vi.hoisted(() => ({
  self: 10,
  entries: [] as EntryRecord[],
  loaded: [] as EntryRecord[],
  conversations: [
    { id: 21, title: 'First feature', busy: true },
    { id: 22, title: 'Second feature', busy: false },
    { id: 99, title: 'Not loaded', busy: false },
  ],
  ui: new Map<string, unknown>(),
  dialogs: new Map<string, boolean>(),
  listeners: new Map<string, (value: unknown) => void>(),
  cells: [] as unknown[],
  cursor: 0,
  search: (_value: string) => {},
  trigger: () => {},
  select: new Map<string, () => void>(),
  popover: { open: false, onOpenChange: (_open: boolean) => {} },
  view: undefined as { thread: number; revealRequest?: { entryId: number } } | undefined,
  pass: ({ children }: { children?: ReactNode }) => children ?? null,
}))
// Retain local state between server renders to exercise selection and reveal callbacks without a DOM.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial?: unknown) => {
    const index = harness.cursor++
    if (!(index in harness.cells)) harness.cells[index] = initial
    return [
      harness.cells[index],
      (next: unknown) => {
        harness.cells[index] = typeof next === 'function' ? next(harness.cells[index]) : next
      },
    ]
  },
}))
vi.mock('@/sdk', () => ({
  defineWebExtension: (facet: unknown) => facet,
  provide: () => ({}),
  api: {},
  useAction: () => ({}),
  getState: () => ({ docsOf: { 1: { standing: { ultimate: 10 } } } }),
  getConversation: (id?: number) => ({ id: id ?? harness.self }),
  useConversation: (select: (value: object) => unknown) =>
    select({ id: harness.self, entries: harness.entries, busy: false }),
  useConversations: () => harness.conversations,
  useDocOf: (_id: number, ref: { kind: string }) =>
    ref.kind === 'standing' ? { ultimate: 10 } : { messages: [] },
  useTranscript: () => harness.loaded,
  useUiState: (key: string, initial: unknown) => [
    harness.ui.get(key) ?? initial,
    (next: unknown) => {
      const previous = harness.ui.get(key) ?? initial
      harness.ui.set(key, typeof next === 'function' ? next(previous) : next)
    },
  ],
  useDialog: (id: string) => [
    harness.dialogs.get(id) ?? false,
    (open: boolean) => harness.dialogs.set(id, open),
  ],
  useEvent: (name: string, handler: (value: unknown) => void) =>
    harness.listeners.set(name, handler),
  events: {
    emit: (name: string, value: unknown) => harness.listeners.get(name)?.(value),
  },
  useNow: () => 100_000,
  formatAgo: (at: number) => `at ${at}`,
  useViewport: () => 'desktop',
  useUltimate: () => ({}),
  Composer: () => null,
  ComposerRedirect: harness.pass,
  ThreadView: (props: typeof harness.view) => {
    harness.view = props
    return h('section', { 'data-view': props?.thread })
  },
}))
vi.mock('../../extensions/conversations/ui.tsx', () => ({
  FeatureTag: ({ feature }: { feature: string }) => h('span', null, feature),
  useOverview: () => ({ 21: { feature: 'F1' }, 22: { feature: 'F2' } }),
}))
vi.mock('../../extensions/messages/ui.tsx', () => ({ MessagesDoc: { kind: 'board' } }))
vi.mock('../../extensions/subagents/ui.tsx', () => ({ StandingDoc: { kind: 'standing' } }))
vi.mock('../../extensions/lineage/ui.tsx', () => ({ AbstractAction: {} }))
vi.mock('../../extensions/workspaces/ui.tsx', () => ({ LandingAfter: {} }))
vi.mock('@/components/ai/message', () => ({ MessageResponse: harness.pass }))
vi.mock('@/components/ui/popover', () => ({
  Popover: (props: typeof harness.popover & { children: ReactNode }) => {
    harness.popover = props
    return props.children
  },
  PopoverTrigger: ({ children }: { children: ReactNode }) => {
    harness.trigger = () => harness.popover.onOpenChange(!harness.popover.open)
    return children
  },
  PopoverContent: ({ children }: { children: ReactNode }) =>
    harness.popover.open ? children : null,
}))
vi.mock('@/components/ui/command', () => ({
  Command: harness.pass,
  CommandEmpty: () => null,
  CommandGroup: harness.pass,
  CommandList: harness.pass,
  CommandInput: ({ onValueChange }: { onValueChange: (value: string) => void }) => {
    harness.search = onValueChange
    return null
  },
  CommandItem: ({
    value,
    onSelect,
    children,
  }: {
    value: string
    onSelect: () => void
    children: ReactNode
  }) => {
    harness.select.set(value, onSelect)
    return h('button', { 'data-choice': value }, children)
  },
}))

import threads from '../../extensions/threads/web.tsx'
import { Threads } from '../../extensions/threads/pane.tsx'
import { ThreadPicker, picker } from '../../extensions/threads/picker.tsx'
import { events } from '@/sdk'

const entry = (id: number, from: number): EntryRecord =>
  ({
    id,
    conversationId: 10,
    kind: 'board.reply',
    input: true,
    data: { id, from, text: `Reply ${id}`, at: id * 1000 },
  }) as unknown as EntryRecord

beforeEach(() => {
  harness.self = 10
  harness.entries = [entry(1, 21), entry(2, 22), entry(3, 21)]
  harness.loaded = []
  harness.ui.clear()
  harness.dialogs.clear()
  harness.listeners.clear()
  harness.cells = []
  harness.cursor = 0
  harness.select.clear()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
})

function render(component = ThreadPicker) {
  harness.cursor = 0
  harness.select.clear()
  return renderToStaticMarkup(h(component))
}

afterEach(() => vi.unstubAllGlobals())

it('opens the same loaded-thread picker from the header and command, ordered by latest activity and searchable', async () => {
  expect(threads.slots!['header.right']).toEqual([ThreadPicker])
  const command = threads.commands!.find((item) => item.title === 'Show threads')!
  const context = {
    conversationId: 10,
    open: (id: string) => harness.dialogs.set(id, true),
  } as unknown as Parameters<typeof command.run>[0]
  expect(command.when!(context)).toBe(true)
  expect(command.when!({ ...context, conversationId: 21 })).toBe(false)
  harness.self = 21
  expect(render()).toBe('')
  harness.self = 10

  expect(render()).toContain('Threads')
  expect(harness.select.size).toBe(0)
  harness.trigger()
  expect(harness.dialogs.get(picker)).toBe(true)
  let html = render()
  expect([...harness.select.keys()]).toEqual(['21', '22'])
  expect(html).toContain('First feature')
  expect(html).toContain('F1')
  expect(html).toContain('class="sr-only">working: ')
  expect(html).toContain('2 new')
  expect(html).toContain('at 3000')
  expect(html).not.toContain('Not loaded')
  expect(html).toContain('Only threads in the loaded conversation.')

  harness.dialogs.set(picker, false)
  await command.run(context)
  render()
  expect([...harness.select.keys()]).toEqual(['21', '22'])
  harness.search('second')
  html = render()
  expect([...harness.select.keys()]).toEqual(['22'])
  expect(html).not.toContain('First feature')
  expect(html).toContain('Only threads in the loaded conversation.')
  harness.search('F1')
  render()
  expect([...harness.select.keys()]).toEqual(['21'])
  harness.search('#22')
  render()
  expect([...harness.select.keys()]).toEqual(['22'])

  harness.search('')
  harness.loaded = [...harness.entries, entry(4, 22)]
  render()
  expect([...harness.select.keys()]).toEqual(['22', '21'])
})

let pane: ReactElement<{ children?: ReactNode }> | null = null
function CapturePane() {
  const element = Threads()!
  const Component = element.type as (props: object) => typeof pane
  pane = Component(element.props)
  return pane
}
function body(node: ReactNode): ReactElement<{ revealRequest?: { entryId: number } }> | undefined {
  if (Array.isArray(node)) return node.map(body).find(Boolean)
  if (!isValidElement<{ children?: ReactNode; revealRequest?: { entryId: number } }>(node))
    return undefined
  if ('revealRequest' in node.props) return node
  return body(node.props.children)
}

it('selects the correct pane, marks it seen and starts a fresh recent-activity visit even when already open after a question reveal', () => {
  harness.dialogs.set(picker, true)
  render()
  const selectFirst = harness.select.get('21')!
  const selectSecond = harness.select.get('22')!
  selectFirst()
  expect(harness.ui.get('ext.threads.open')).toBe(21)
  expect(harness.ui.get('ext.threads.seen')).toEqual({ 21: 3 })
  expect(harness.dialogs.get(picker)).toBe(false)

  harness.cells = []
  render(CapturePane)
  expect(harness.view?.thread).toBe(21)
  events.emit('ultimate:reveal-thread', { conversationId: 10, threadId: 21, entryId: 1 })
  render(CapturePane)
  expect(harness.view?.revealRequest?.entryId).toBe(1)
  const before = body(pane)!.key
  selectFirst()
  render(CapturePane)
  expect(harness.ui.get('ext.threads.open')).toBe(21)
  expect(harness.view?.revealRequest).toBeUndefined()
  expect(body(pane)!.key).not.toBe(before)

  selectSecond()
  render(CapturePane)
  render(CapturePane)
  expect(harness.view?.thread).toBe(22)
  expect(harness.view?.revealRequest).toBeUndefined()
  expect(harness.ui.get('ext.threads.seen')).toEqual({ 21: 3, 22: 2 })
})
