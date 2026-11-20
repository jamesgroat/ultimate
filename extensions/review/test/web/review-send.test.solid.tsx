/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { createSignal, flush } from 'solid-js'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { draftsKey } from '../../comments.ts'
import type { Drafts } from '../../drafts.ts'
import { DiffAction, SendAction } from '../../refs.ts'

const shell = vi.hoisted(() => ({
  source: undefined as string | undefined,
  state: {} as Record<string, unknown>,
  action: vi.fn<(_ref: unknown, _args: unknown) => Promise<{ conversation: number }>>(async () => ({
    conversation: 22,
  })),
  useAction: vi.fn<(ref: { name: string }, args: unknown, options: unknown) => unknown>(),
}))
vi.mock('@/sdk/solid', () => ({
  ROOT: 1,
  api: { action: shell.action },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  errorMessage: String,
  keepLast: () => undefined,
  Provided: () => null,
  useAction: shell.useAction,
  useExtensionUiState: (key: string, initial: unknown) => createSignal(shell.state[key] ?? initial),
  useStore: () => () => 'dark',
  useConversationId: () => () => parseConversationId(11),
  useViewport: () => () => 'desktop',
  writingAs: (_source: unknown, run: () => void) => run(),
}))
vi.mock('../../../messages/ui.solid.tsx', () => ({ Address: () => null }))
vi.mock('../../../workspaces/ui.solid.tsx', () => ({ useGithubRepo: () => () => undefined }))
vi.mock('../../drafts.solid.tsx', () => ({
  useDrafts: (key: () => string) => [() => shell.state[key()] as Drafts, () => true],
}))
vi.mock('../../parts.solid.tsx', () => ({
  Frame: (props: { children: JSX.Element }) => <>{props.children}</>,
  Loading: () => null,
  Notice: () => null,
}))
vi.mock('../../ui.solid.tsx', () => ({ SourcePicker: {} }))
vi.mock('../../selector.solid.tsx', () => ({ Selector: () => null }))
vi.mock('../../recipient.solid.tsx', () => ({ Recipient: () => null }))
vi.mock('../../link.solid.tsx', () => ({
  useSpec: () => [() => 'uncommitted', () => {}],
  useSource: () => [() => shell.source, () => {}],
  useTarget: () => () => undefined,
}))
vi.mock('../../footer.solid.tsx', () => ({
  Footer: (props: { onSend: (source: string) => Promise<void>; disabled: boolean }) => (
    <input
      type="button"
      aria-label="Send test review"
      disabled={props.disabled}
      onClick={() => void props.onSend('agent')}
    />
  ),
}))

const { default: ReviewSurface } = await import('../../surface.solid.tsx')

it.each([undefined, 'repo:checkout'])(
  'sends to recipient 22 rather than checkout conversation 11 (source: %s)',
  async (source) => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    shell.source = source
    shell.action.mockClear()
    shell.useAction.mockReset()
    const draft: Drafts = {
      comments: [{ id: 'draft', file: 'a.ts', side: 'new', start: 1, end: 1, text: 'Fix.' }],
      note: 'Check this.',
      to: parseConversationId(22),
    }
    shell.state = {
      [draftsKey(
        'uncommitted',
        source === undefined ? parseConversationId(11) : undefined,
        source,
      )]: draft,
    }
    const args =
      source === undefined
        ? { spec: 'uncommitted', conversation: 11, source: undefined }
        : { spec: 'uncommitted', source, conversation: undefined }
    shell.useAction.mockImplementation((ref) => ({
      loading: () => false,
      error: () => undefined,
      data: () =>
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
    const container = renderSolid(() => <ReviewSurface />)
    flush()
    expect(shell.useAction).toHaveBeenCalledWith(DiffAction, args, {
      conversation: 1,
      onError: expect.any(Function),
    })
    const send = container.querySelector<HTMLInputElement>('[aria-label="Send test review"]')!
    expect(send.disabled).toBe(false)
    send.click()
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
