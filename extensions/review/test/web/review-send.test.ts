import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { draftsKey } from '../../comments.ts'
import type { Drafts } from '../../drafts.ts'
import { DiffAction, SendAction } from '../../refs.ts'

const shell = vi.hoisted(() => ({
  source: undefined as string | undefined,
  state: {} as Record<string, unknown>,
  send: undefined as (() => void) | undefined,
  action: vi.fn<(ref: typeof SendAction, args: unknown) => Promise<{ conversation: number }>>(
    async () => ({ conversation: 22 }),
  ),
  useAction:
    vi.fn<
      (
        ref: { name: string },
        args: unknown,
        options: unknown,
      ) => { loading: boolean; data: unknown }
    >(),
}))
vi.mock('@/sdk', () => ({
  api: { action: shell.action },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  definePoint: () => ({}),
  errorMessage: String,
  Provided: () => null,
  useAction: shell.useAction,
  useExtensionUiState: (key: string, initial: unknown) => [
    shell.state[key] ?? initial,
    (next: unknown) => {
      shell.state[key] = typeof next === 'function' ? next(shell.state[key] ?? initial) : next
    },
  ],
  useStore: () => 'dark',
  useUltimate: () => ({ conversationId: 11 }),
  useViewport: () => 'desktop',
}))
// Keep the real surface's send handler and draft storage hook; the viewer and shell need no browser here.
vi.mock('@pierre/diffs/react', () => ({
  FileDiff: () => null,
  Virtualizer: ({ children }: { children?: ReactNode }) => children,
}))
vi.mock('../../../messages/ui.tsx', () => ({ Address: () => null }))
vi.mock('../../../workspaces/ui.tsx', () => ({ useGithubRepo: () => undefined }))
vi.mock('../../comment.tsx', () => ({ Composer: () => null, DraftCard: () => null }))
vi.mock('../../parts.tsx', () => ({
  Frame: ({ children }: { children?: ReactNode }) => children,
  Loading: () => null,
  Notice: () => null,
}))
vi.mock('../../selector.tsx', () => ({ Selector: () => null }))
vi.mock('../../recipient.tsx', () => ({ Recipient: () => null }))
vi.mock('../../link.tsx', () => ({
  useSpec: () => ['uncommitted', () => {}],
  useSource: () => [shell.source, () => {}],
  useTarget: () => undefined,
  reachedTarget: () => {},
}))
vi.mock('../../footer.tsx', () => ({
  Footer: ({ onSend, disabled }: { onSend: () => void; disabled: boolean }) => {
    if (!disabled) shell.send = onSend
    return null
  },
}))

const { default: ReviewSurface } = await import('../../surface.tsx')

// Checkout selection must never overwrite the recipient chosen by the user (#164559).
it.each([undefined, 'repo:checkout'])(
  'sends to recipient 22 rather than checkout conversation 11 (source: %s)',
  async (source) => {
    shell.source = source
    shell.send = undefined
    shell.action.mockClear()
    shell.useAction.mockReset()
    const draft: Drafts = {
      comments: [{ id: 'draft', file: 'a.ts', side: 'new', start: 1, end: 1, text: 'Fix.' }],
      note: 'Check this.',
      to: 22,
    }
    shell.state = {
      [draftsKey('uncommitted', source === undefined ? 11 : undefined, source)]: draft,
    }
    const args =
      source === undefined
        ? { spec: 'uncommitted', conversation: 11 }
        : { spec: 'uncommitted', source }
    shell.useAction.mockImplementation((ref) => ({
      loading: false,
      data:
        ref.name === 'diff'
          ? {
              spec: 'uncommitted',
              source,
              kind: 'uncommitted',
              title: 'Uncommitted changes',
              patch: '',
              files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 1 }],
            }
          : { conversation: 11 },
    }))

    renderToStaticMarkup(createElement(ReviewSurface))
    expect(shell.useAction).toHaveBeenCalledWith(DiffAction, args, expect.anything())
    expect(shell.send).toBeDefined()
    shell.send!()
    await Promise.resolve()
    expect(shell.action).toHaveBeenCalledExactlyOnceWith(SendAction, {
      conversation: 22,
      spec: 'uncommitted',
      ...(source !== undefined && { source }),
      comments: [{ file: 'a.ts', side: 'new', start: 1, end: 1, text: 'Fix.', excerpt: '' }],
      note: 'Check this.',
    })
  },
)
