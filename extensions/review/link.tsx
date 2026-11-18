import { useEffect, useSyncExternalStore } from 'react'
import { useExtensionUiState, useUltimate } from '@/sdk'

export const useSpec = () => useExtensionUiState<string>('spec', 'uncommitted')

export function useSource() {
  const [source, set] = useExtensionUiState<string | null>('source', null)
  return [source ?? undefined, (next: string | undefined) => set(next ?? null)] as const
}

export type ReviewTarget = { file: string; line: number; side?: 'old' | 'new' }

type Request = { spec: string; source?: string; at?: ReviewTarget }

const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const notify = () => {
  for (const listener of listeners) listener()
}

function fromAddress(): Request | undefined {
  const params = new URL(location.href).searchParams
  const spec = params.get('review')
  if (!spec) return undefined
  const file = params.get('file')
  const line = Number(params.get('line'))
  const side = params.get('side') === 'old' ? 'old' : undefined
  return {
    spec,
    ...(params.has('reviewSource') ? { source: params.get('reviewSource')! } : {}),
    ...(file && Number.isSafeInteger(line) && line > 0
      ? { at: { file, line, ...(side && { side }) } }
      : {}),
  }
}

let pendingReviewRequest = fromAddress()
let unreachedLineTarget: ReviewTarget | undefined

export function openReview(spec: string, at?: ReviewTarget, source?: string) {
  pendingReviewRequest = { spec, ...(at && { at }), ...(source !== undefined && { source }) }
  notify()
}

export const useTarget = () => useSyncExternalStore(subscribe, () => unreachedLineTarget)

export function reachedTarget() {
  unreachedLineTarget = undefined
  notify()
}

export function ReviewLink() {
  const wanted = useSyncExternalStore(subscribe, () => pendingReviewRequest)
  const [spec, setSpec] = useSpec()
  const [source, setSource] = useExtensionUiState<string | null>('source', null)
  const { surface, showSurface } = useUltimate()
  useEffect(() => {
    if (wanted === undefined) return
    pendingReviewRequest = undefined
    unreachedLineTarget = wanted.at
    setSpec(wanted.spec)
    setSource(wanted.source ?? null)
    showSurface('review')
    notify()
  }, [wanted, setSpec, setSource, showSurface])
  useEffect(() => {
    if (pendingReviewRequest !== undefined) return
    const url = new URL(location.href)
    const shown = surface === 'review' ? spec : null
    const shownSource = surface === 'review' ? source : null
    if (
      url.searchParams.get('review') === shown &&
      url.searchParams.get('reviewSource') === shownSource
    )
      return
    if (shown === null) url.searchParams.delete('review')
    else url.searchParams.set('review', shown)
    if (shownSource === null) url.searchParams.delete('reviewSource')
    else url.searchParams.set('reviewSource', shownSource)
    const previousSpecLineParameters = ['file', 'line', 'side']
    for (const name of previousSpecLineParameters) url.searchParams.delete(name)
    history.replaceState(history.state, '', url)
  }, [surface, spec, source])
  return null
}
