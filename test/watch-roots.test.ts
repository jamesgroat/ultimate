import { expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  present: new Set(['/work']),
  watches: [] as { path: string; changed: () => void; close: ReturnType<typeof vi.fn> }[],
}))
vi.mock('node:fs', () => ({
  existsSync: (path: string) => native.present.has(path),
  watch: (path: string, changed: () => void) => {
    const watcher = { path, changed, close: vi.fn<() => void>() }
    native.watches.push(watcher)
    return watcher
  },
}))
import { watchRoots } from '../server/watch-roots.ts'

it('shares ancestor watches across roots and consumers until the last subscriber closes', () => {
  const first = vi.fn<(root: string) => void>()
  const second = vi.fn<(root: string) => void>()
  const stopFirst = watchRoots(['/work/user/settings', '/work/user/extensions'], first)
  const stopSecond = watchRoots(['/work/user/extensions'], second)
  try {
    expect(native.watches.map(({ path }) => path)).toEqual(['/work'])
    native.present.add('/work/user')
    native.present.add('/work/user/extensions')
    native.watches[0].changed()
    expect(native.watches.map(({ path }) => path)).toEqual(['/work', '/work/user'])
    expect(native.watches[0].close).toHaveBeenCalledTimes(1)
    expect(first.mock.calls).toEqual([['/work/user/extensions']])
    expect(second.mock.calls).toEqual([['/work/user/extensions']])
    stopFirst()
    expect(native.watches[1].close).not.toHaveBeenCalled()
    native.present.delete('/work/user/extensions')
    native.watches[1].changed()
    native.present.add('/work/user/extensions')
    native.watches[1].changed()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    stopSecond()
    expect(native.watches[1].close).toHaveBeenCalledTimes(1)
  } finally {
    stopFirst()
    stopSecond()
  }
  expect(native.watches.every(({ close }) => close.mock.calls.length === 1)).toBe(true)
})
