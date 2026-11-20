import type { ConversationId } from '@earendil-works/pi-durable'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord/json'
import type { UiState } from '../../web/src/sdk/store.ts'

const { shared, ui, width, touch, touchScreen, listeners } = vi.hoisted(() => {
  const tab: { current: Partial<UiState> } = { current: {} }
  return {
    shared: new Map<string, JsonValue>(),
    ui: tab,
    width: { current: 390 },
    touch: { current: false },
    touchScreen: { current: false },
    listeners: new Map<string, Set<() => void>>(),
  }
})
vi.mock('../../web/src/sdk/client.ts', () => ({
  registry: { getSnapshot: () => [] },
  store: {
    getState: () => ({ ui: ui.current }),
    setUi: (change: Partial<UiState>) => (ui.current = { ...ui.current, ...change }),
  },
  uiState: {
    get: (key: string) => shared.get(key),
    set: (key: string, value: JsonValue) => shared.set(key, value),
  },
}))
vi.stubGlobal('matchMedia', (query: string) => {
  const registered = listeners.get(query) ?? new Set()
  listeners.set(query, registered)
  return {
    get matches() {
      if (query === '(pointer: coarse)') return touch.current
      if (query === '(any-pointer: coarse)') return touch.current || touchScreen.current
      return width.current >= Number(/(\d+)px/.exec(query)![1])
    },
    addEventListener: (_: 'change', listener: () => void) => registered.add(listener),
    removeEventListener: (_: 'change', listener: () => void) => registered.delete(listener),
  }
})

const { actions, regionOpen } = await import('../../web/src/sdk/actions.ts')
const { viewport, overlays, subscribeViewport } = await import('../../web/src/sdk/viewport.ts')

beforeEach(() => {
  shared.clear()
  ui.current = {}
  touch.current = false
  touchScreen.current = false
})

describe('viewport', () => {
  it.each([
    [1200, false, 'desktop'],
    [1200, true, 'tablet'],
    [1024, false, 'desktop'],
    [1024, true, 'tablet'],
    [1023, false, 'tablet'],
    [1023, true, 'tablet'],
    [800, true, 'tablet'],
    [768, false, 'tablet'],
    [768, true, 'tablet'],
    [767, false, 'phone'],
    [767, true, 'phone'],
    [500, false, 'phone'],
    [500, true, 'phone'],
  ] as const)(
    'classifies %ipx with coarse primary pointer %s as %s',
    (pixels, coarse, expected) => {
      width.current = pixels
      touch.current = coarse
      expect(viewport()).toBe(expected)
    },
  )

  it('keeps a wide touch-screen laptop driven by its trackpad on the desktop layout', () => {
    width.current = 1200
    touchScreen.current = true
    expect(viewport()).toBe('desktop')
  })

  it('notifies subscribers when the primary pointer turns coarse or fine, and unsubscribes from every query', () => {
    width.current = 1200
    const seen: string[] = []
    const unsubscribe = subscribeViewport(() => seen.push(viewport()))
    const queries = ['(min-width: 768px)', '(min-width: 1024px)', '(pointer: coarse)']
    expect(queries.map((query) => listeners.get(query)!.size)).toEqual([1, 1, 1])
    for (const coarse of [true, false]) {
      touch.current = coarse
      for (const listener of listeners.get('(pointer: coarse)')!) listener()
    }
    expect(seen).toEqual(['tablet', 'desktop'])
    unsubscribe()
    expect(queries.map((query) => listeners.get(query)!.size)).toEqual([0, 0, 0])
  })
})

describe('sidebar and panel', () => {
  it('keep their shared state on a desktop', () => {
    width.current = 1440
    expect(regionOpen('sidebar')).toBe(true)
    actions.toggleSidebar()
    actions.openPanel('info')
    expect(Object.fromEntries(shared)).toEqual({
      'shell.sidebarOpen': false,
      'shell.panelOpen': true,
      'shell.panel': 'info',
    })
    expect(ui.current.open).toBeUndefined()
  })

  it('start closed on a phone and never touch the shared state there', () => {
    width.current = 390
    shared.set('shell.sidebarOpen', true)
    expect(regionOpen('sidebar')).toBe(false)
    actions.toggleSidebar()
    expect(regionOpen('sidebar')).toBe(true)
    expect(shared.get('shell.sidebarOpen')).toBe(true)
  })

  it('never stack as overlays on a phone, and close when the conversation changes', () => {
    width.current = 390
    actions.toggleSidebar()
    actions.openPanel()
    expect([regionOpen('sidebar'), regionOpen('panels')]).toEqual([false, true])
    actions.switchConversation(7 as ConversationId)
    expect(regionOpen('panels')).toBe(false)
  })

  it('keep a docked sidebar beside the panel overlay on a wide touch tablet, and each viewport its own state', () => {
    width.current = 1200
    touch.current = true
    expect(overlays('sidebar')).toBe(false)
    expect(overlays('panels')).toBe(true)
    // Unfolded, the chats dock beside the conversation from the start.
    expect([regionOpen('sidebar'), regionOpen('panels')]).toEqual([true, false])
    actions.openPanel()
    expect([regionOpen('sidebar'), regionOpen('panels')]).toEqual([true, true])
    actions.switchConversation(7 as ConversationId)
    expect([regionOpen('sidebar'), regionOpen('panels')]).toEqual([true, false])
    // Folded, the phone shows the conversation; unfolded, the sidebar docks again.
    width.current = 390
    expect(regionOpen('sidebar')).toBe(false)
    width.current = 1200
    expect(regionOpen('sidebar')).toBe(true)
    actions.toggleSidebar()
    expect(regionOpen('sidebar')).toBe(false)
    expect(shared.get('shell.sidebarOpen')).toBeUndefined()
  })
})
