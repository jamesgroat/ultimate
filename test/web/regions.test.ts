import type { ConversationId } from '@earendil-works/pi-durable'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord/json'
import type { UiState } from '../../web/src/sdk/store.ts'

const { shared, ui, width, touch } = vi.hoisted(() => {
  const tab: { current: Partial<UiState> } = { current: {} }
  return {
    shared: new Map<string, JsonValue>(),
    ui: tab,
    width: { current: 390 },
    touch: { current: false },
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
vi.stubGlobal('matchMedia', (query: string) => ({
  get matches() {
    return query === '(any-pointer: coarse)'
      ? touch.current
      : width.current >= Number(/(\d+)px/.exec(query)![1])
  },
  addEventListener: () => {},
  removeEventListener: () => {},
}))

const { actions, regionOpen } = await import('../../web/src/sdk/actions.ts')
const { viewport, overlays } = await import('../../web/src/sdk/viewport.ts')

beforeEach(() => {
  shared.clear()
  ui.current = {}
  touch.current = false
})

describe('viewport', () => {
  it.each([
    [1200, false, 'desktop'],
    [1200, true, 'tablet'],
    [800, true, 'tablet'],
    [500, false, 'phone'],
    [500, true, 'phone'],
  ] as const)('classifies %ipx with coarse pointer %s as %s', (pixels, coarse, expected) => {
    width.current = pixels
    touch.current = coarse
    expect(viewport()).toBe(expected)
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
