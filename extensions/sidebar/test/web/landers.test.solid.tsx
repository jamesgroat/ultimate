/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ROOT } from '@/sdk/solid'
import { parseConversationId } from '../../../../lib/ids.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store } from '../../../../web/src/sdk/client.ts'
import { StandingDoc } from '../../../subagents/refs.ts'
import { WorkspacesDoc } from '../../../workspaces/refs.ts'
import { Conversations } from '../../sidebar.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    harness.server?.handle(input as string, init) ?? Response.json({ result: [] })
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const clientStore = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: pageFetch,
  })
  const api = createApi(clientStore, { fetch: pageFetch })
  return {
    store: clientStore,
    api,
    reads: createReads(api, clientStore),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})
vi.mock('../../landed.solid.tsx', () => ({
  useLandings: () => () => [],
  Landed: () => <section aria-label="Landed">Recent feature</section>,
}))

it('keeps repository-labelled landers and renders their combined history only once after them', async ({
  onTestFinished,
}) => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  harness.server = fakeSubscriptions(harness.sources)
  store.start()
  onTestFinished(() => {
    store.stop()
    vi.unstubAllGlobals()
  })
  const stream = harness.sources.at(-1)!
  stream.open()
  stream.send('conversations', [
    { id: parseConversationId(2), label: 'lander', busy: false },
    { id: parseConversationId(3), label: 'lander', busy: false },
  ])
  const container = renderSolid(() => <Conversations />)
  await settle()
  const root = harness.server.of(ROOT)!
  root.send('doc', { kind: StandingDoc.kind, value: {} })
  root.send('doc', {
    kind: WorkspacesDoc.kind,
    value: {
      items: {},
      queue: [],
      results: {},
      landers: {},
      landerConversations: { '/projects/app': 2, '/projects/engine': 3 },
    },
  })
  flush()
  expect(container.querySelectorAll('[data-standing="lander"]')).toHaveLength(2)
  expect(container.querySelector('span[title="/projects/app"]')?.textContent).toBe('app')
  expect(container.querySelector('span[title="/projects/engine"]')?.textContent).toBe('engine')
  expect(container.querySelectorAll('[aria-label="Landed"]')).toHaveLength(1)
  const last = container.querySelector('[data-conversation="3"]')!
  const landed = container.querySelector('[aria-label="Landed"]')!
  expect(last.compareDocumentPosition(landed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
