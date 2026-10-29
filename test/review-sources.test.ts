import { expect, it, vi } from 'vitest'
import { ReviewSources } from '../extensions/review/api.ts'
import type { ReviewSourcesService } from '../extensions/review/api.ts'
import { reviewDiff } from '../extensions/review/diff.ts'
import { actions } from '../extensions/review/server.ts'
import { SubagentsApi } from '../extensions/subagents/api.ts'
import { WorkspacesApi } from '../extensions/workspaces/api.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'

vi.mock('../extensions/review/diff.ts', () => ({ reviewDiff: vi.fn<typeof reviewDiff>() }))

it('resolves trusted sources for diffs, choices, recipients and a fresh, server-labelled review input', async () => {
  const source = 'repo:checkout'
  let resolved: Awaited<ReturnType<ReviewSourcesService['resolve']>> = {
    cwd: '/trusted/checkout',
    label: 'My app',
    base: 'main',
  }
  const resolve = vi.fn<ReviewSourcesService['resolve']>(async () => resolved)
  const provider: ReviewSourcesService = {
    resolve,
    ranges: async () => [{ spec: 'uncommitted', group: 'Working tree', label: 'Changes' }],
  }
  type ReviewInput = {
    content: string
    entry: { kind: string; data: unknown }
    whenBusy: string
  }
  const submit = vi.fn<(input: ReviewInput) => Promise<unknown>>(async () => ({
    id: 'submission',
    status: async () => ({ entry: 42 }),
  }))
  const workspaceDoc = Symbol('workspaces')
  const host = {
    projectRoot: '/native/project',
    want: (api: unknown) => (api === ReviewSources ? provider : undefined),
    need: (api: unknown) => {
      if (api === WorkspacesApi) return { doc: workspaceDoc }
      if (api === SubagentsApi) return { standing: async () => 1 }
      throw new Error('Unexpected service')
    },
    conversations: () => [{ id: 1 }, { id: 2 }],
    harness: () => ({
      snapshot: async () => ({ items: { '2': { state: 'ready', path: '/other/worktree' } } }),
      conversation: async () => ({ submit }),
      commit: async (change: (tx: unknown) => void) => change({}),
    }),
    emit: () => {},
  } as unknown as ExtensionHost
  const ctx: ActionContext = {
    host,
    signal: new AbortController().signal,
    exec: vi.fn<ActionContext['exec']>(),
  }
  vi.mocked(reviewDiff).mockImplementation(async (cwd, spec, options) => {
    expect(cwd).toBe(resolved.cwd)
    expect(await options.target('feature')).toBe(resolved.base)
    return { spec, kind: 'branch', title: 'main...feature', files: [], patch: '' }
  })

  const diff = await actions.diff({ source, spec: 'branch:feature' }, ctx)
  expect(diff).toMatchObject({ source, sourceLabel: 'My app' })
  expect(diff.github).toBeUndefined()
  expect(resolve).toHaveBeenCalledWith(source)
  expect(await actions.ranges({ source }, ctx)).toEqual(await provider.ranges(source))
  // No native commit trailer inference: only the provider can corroborate ownership of an external commit.
  expect(await actions.recipient({ source, spec: 'deadbeef' }, ctx)).toEqual({ conversation: 1 })
  resolved = { ...resolved, recipient: 2 }
  expect(await actions.recipient({ source, spec: 'deadbeef' }, ctx)).toEqual({ conversation: 2 })

  // The recipient owns another checkout: routing a review there must not change or constrain its source.
  // The checkout/label changed since the diff; the browser cannot supply either one at send time.
  resolved = { cwd: '/trusted/new-checkout', label: 'Renamed app', base: 'develop' }
  expect(
    await actions.send(
      {
        source,
        sourceLabel: 'Forged label',
        cwd: '/forged/checkout',
        spec: 'uncommitted',
        conversation: 2,
        comments: [{ file: 'a.ts', side: 'new', start: 1, end: 1, excerpt: '', text: 'Fix.' }],
      },
      ctx,
    ),
  ).toEqual({ conversation: 2 })
  expect(submit).toHaveBeenCalledOnce()
  const input = submit.mock.calls[0][0]
  expect(input.entry).toEqual({
    kind: 'review.comments',
    data: {
      source,
      sourceLabel: 'Renamed app',
      cwd: '/trusted/new-checkout',
      spec: 'uncommitted',
      comments: [{ file: 'a.ts', side: 'new', start: 1, end: 1, excerpt: '', text: 'Fix.' }],
    },
  })
  expect(input.content).toBe(
    'Review of `uncommitted` (1 comment)\n\nSource: `Renamed app`\nCheckout: `/trusted/new-checkout`\n\n`a.ts:1` (new)\nFix.',
  )
  expect(input.whenBusy).toBe('steer')
  expect(resolve).toHaveBeenCalledTimes(5)
})
