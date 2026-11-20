import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import { isMissing } from '../lib/errors.ts'

const ancestors = new Map<
  string,
  { watcher: ReturnType<typeof watch>; listeners: Set<() => void> }
>()

function watchAncestor(path: string, changed: () => void) {
  let shared = ancestors.get(path)
  if (!shared) {
    const listeners = new Set<() => void>()
    const watcher = watch(path, () => {
      ;[...listeners].forEach((listener) => listener())
    })
    shared = { watcher, listeners }
    ancestors.set(path, shared)
  }
  const { watcher, listeners } = shared
  listeners.add(changed)
  return () => {
    if (!listeners.delete(changed) || listeners.size) return
    ancestors.delete(path)
    watcher.close()
  }
}

export function watchRoots(roots: string[], appeared: (root: string) => void) {
  const cleanups = roots.map((root) => {
    let closed = false
    let present = existsSync(root)
    let stop: (() => void) | undefined
    let watchedAncestor: string | undefined
    const attach = () => {
      let ancestor = dirname(root)
      while (!existsSync(ancestor)) ancestor = dirname(ancestor)
      const nearestExistingAncestorChanged = ancestor !== watchedAncestor
      if (nearestExistingAncestorChanged) {
        stop?.()
        for (;;) {
          try {
            stop = watchAncestor(ancestor, () => {
              if (!closed) attach()
            })
            watchedAncestor = ancestor
            break
          } catch (error) {
            if (!isMissing(error)) throw error
            ancestor = dirname(ancestor)
          }
        }
      }
      const next = existsSync(root)
      if (next && !present) appeared(root)
      present = next
    }
    attach()
    return () => {
      closed = true
      stop?.()
    }
  })
  return () => cleanups.forEach((close) => close())
}
