/** @jsxImportSource @solidjs/web */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { events } from '@/sdk/solid'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { shellKeys } from '../../../../web/src/sdk/actions.ts'
import { uiState } from '../../../../web/src/sdk/client.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import { Failure } from '../../failure.solid.tsx'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
  }
})

const agent = createAgent()

it('labels the failure and opens its full error at the failed entry as the agent', async ({
  onTestFinished,
}) => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const conversation = parseConversationId(17)
  const entry = parseEntryId(42)
  const received = vi.fn<(value: unknown, writer: string) => void>()
  onTestFinished(events.on('messages:open', (value) => received(value, writerNow())))
  uiState.set(shellKeys.surface, 'inbox')
  const report = {
    id: parseEntryId(50),
    conversationId: parseConversationId(1),
    kind: 'watchdog.failure',
    data: {
      conversation,
      title: 'Fix the build',
      class: 'login',
      error: 'Provider is not configured: faux',
      entry,
      step: 'model request',
      retried: false,
    },
  } as unknown as EntryRecord
  const view = renderSolid(() => <Failure core={null} entry={report} />)
  flush()
  expect(view.querySelector('header')?.textContent).toContain('login')
  expect(view.querySelector('[data-failure-entry]')?.getAttribute('data-failure-entry')).toBe('42')
  await expectDistinctAgentNames(agent)
  const open = agent.snapshot().find((control) => control.label?.startsWith('Open full error'))!
  expect(await agent.act({ steps: [{ ref: open.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  expect(uiState.get(shellKeys.conversation)).toBe(conversation)
  expect(uiState.get(shellKeys.surface)).toBe('agent')
  expect(received).toHaveBeenCalledExactlyOnceWith({ conversation, entry }, 'agent')
})
