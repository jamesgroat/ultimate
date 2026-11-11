import { afterEach, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { awaitWithContext } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import type { Task } from '@earendil-works/pi-durable'
import {
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { context, prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { emit } from '../../../server/events.ts'
import { Metadata } from '../../../server/metadata.ts'
import { idleNeed, removeTemp, temp, until } from '../../../test/helpers.ts'
import messages from '../../messages/server.ts'
import { Messages } from '../../messages/api.ts'
import { Standing } from '../../subagents/api.ts'
import questions from '../server.ts'
import watchdog from '../../watchdog/server.ts'

const ASK = 'Want me to run the QA re-check now, or wait until the change is merged?'
const card = fauxAssistantMessage(
  [
    fauxToolCall('message', {
      to: 'user',
      text: 'Choose the timing.',
      questions: [{ text: 'Run the QA re-check now?', kind: 'confirm' }],
    }),
  ],
  { stopReason: 'toolUse' },
)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close()
})

async function fixture(
  options: { off?: boolean; noMessage?: boolean; restart?: boolean; retry?: boolean } = {},
) {
  const home = await temp('ultimate-final-ask-')
  cleanups.push(() => removeTemp(home))
  if (options.off) {
    await mkdir(join(home, '.ultimate'), { recursive: true })
    await writeFile(
      join(home, '.ultimate/settings.json'),
      JSON.stringify({ questions: { nudgeFinalAsk: false } }),
    )
  }
  const reports: string[] = []
  const prepared = await prepareHarness({
    home,
    ultimateRoot: home,
    userHome: home,
    faux: fauxProvider(),
    report: (notice) => {
      reports.push(notice.message)
    },
  })
  let opened: OpenHost
  const host = {
    ...prepared,
    metadata: Metadata,
    emit,
    harness: () => opened.harness,
    implement: () => {},
    need: (api: Parameters<typeof idleNeed>[0]) =>
      api.name === 'subagents' ? { residents: async () => [] } : idleNeed(api),
    conversations: () => [],
    projects: async () => [],
    projectSettings: async () => ({}),
  } as unknown as ExtensionHost
  const backend = messages(host)
  prepared.registry.install(options.noMessage ? { ...backend, tools: [] } : backend)
  prepared.registry.install(questions(host))
  const retry = options.retry
    ? (watchdog({ ...host, onOpen: () => {}, onClose: () => {}, onRelease: () => {} })
        .tasks![0] as Task<JsonValue, { phase: string }, null, object>)
    : undefined
  if (retry) prepared.registry.install(defineExtension({ name: 'retry-probe', tasks: [retry] }))
  let blocked = false
  const release = Promise.withResolvers<void>()
  let requests = 0
  prepared.registry.install(
    defineExtension({
      name: 'restart-probe',
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (_request, _api, ctx) => {
            requests++
            if (options.restart && requests === 2) {
              blocked = true
              await awaitWithContext(release.promise, ctx)
            }
            return undefined
          },
        }),
      ],
    }),
  )
  opened = await prepared.open()
  cleanups.push(async () => {
    await opened.close()
    expect(reports).toEqual([])
  })
  await opened.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = opened.root.id
  }, context)
  const log = () => opened.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const run = async (
    responses: Parameters<NonNullable<typeof prepared.faux>['setResponses']>[0],
    entry?: { kind: string; data: { from?: number | string } },
  ) => {
    prepared.faux!.setResponses(responses)
    const submission = await opened.root.submit(
      { type: 'input', content: 'Review the result.', ...(entry ? { entry } : {}) },
      context,
    )
    await submission.wait(context)
    await opened.root.waitForIdle(context)
  }
  return {
    run,
    log,
    prepared,
    retry,
    get opened() {
      return opened
    },
    async restart() {
      await until(() => blocked)
      await opened.close()
      release.resolve()
      opened = await prepared.open()
    },
  }
}

it('nudges the missed final ask once into a native card, retaining the prose across restart', async () => {
  const f = await fixture({ restart: true })
  let turns = 0
  const first: FauxResponseFactory = () => {
    turns++
    return fauxAssistantMessage([fauxText(ASK)])
  }
  const corrected: FauxResponseFactory = (transcript) => {
    turns++
    expect(JSON.stringify(transcript.messages)).toContain(ASK)
    expect(JSON.stringify(transcript.messages)).toContain('only corrective nudge')
    return card
  }
  // Wait on the reopened conversation rather than the old host's submission handle.
  f.prepared.faux!.setResponses([first, corrected])
  await f.opened.root.submit({ type: 'input', content: 'Review the result.' }, context)
  await f.restart()
  await f.opened.root.waitForIdle(context)
  expect(turns).toBe(2)
  expect((await f.log())!.messages).toMatchObject([
    {
      to: 'user',
      state: 'delivered',
      questions: [{ text: 'Run the QA re-check now?', kind: 'confirm' }],
    },
  ])
  const entries = (await f.opened.root.context(context)).entries
  expect(JSON.stringify(entries)).toContain(ASK)
})

it('caps repeated prose across restart, but allows a new user run to try again', async () => {
  const f = await fixture({ restart: true })
  let turns = 0
  const repeat: FauxResponseFactory = () => {
    turns++
    return fauxAssistantMessage([fauxText(ASK)])
  }
  f.prepared.faux!.setResponses([repeat, repeat])
  await f.opened.root.submit({ type: 'input', content: 'Review the result.' }, context)
  await f.restart()
  await f.opened.root.waitForIdle(context)
  expect(turns).toBe(2)
  expect((await f.log())?.messages ?? []).toHaveLength(0)
  await f.run([repeat, card])
  expect(turns).toBe(3)
  expect((await f.log())!.messages[0].questions).toHaveLength(1)
})

it('leaves opt-out and message-unavailable runs alone', async () => {
  for (const options of [{ off: true }, { noMessage: true }]) {
    const f = await fixture(options)
    let turns = 0
    await f.run([
      () => {
        turns++
        return fauxAssistantMessage([fauxText(ASK)])
      },
    ])
    expect(turns).toBe(1)
  }
})

it('excludes peer/branch origins, injected user-role notes and non-primary agents', async () => {
  const f = await fixture()
  const other = await f.opened.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  for (const entry of [
    { kind: 'board.message', data: { from: 'remote' } },
    { kind: 'board.reply', data: { from: other.id } },
    { kind: 'board.message', data: { from: other.id } },
    { kind: 'board.open', data: {} },
  ]) {
    let turns = 0
    await f.run(
      [
        () => {
          turns++
          return fauxAssistantMessage([fauxText(ASK)])
        },
      ],
      entry,
    )
    expect(turns).toBe(1)
  }
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = other.id
  }, context)
  await f.run([fauxAssistantMessage([fauxText(ASK)])])
  expect((await f.log())?.messages ?? []).toHaveLength(0)
})

it('does not nudge a watchdog retry of a failed automation-origin run admitted as pi.user', async () => {
  const f = await fixture({ retry: true })
  f.prepared.settings.applyOverrides({ retry: { enabled: false } })
  const error = 'Incomplete Claude Code upstream response (status 200, dropped stream)'
  await f.run([fauxAssistantMessage('', { stopReason: 'error', errorMessage: error })], {
    kind: 'automations.fired',
    data: {},
  })
  const failure = (await f.opened.harness.snapshot(LiveDoc, f.opened.root.id, context))!.runFailure!
  expect(failure.reason).toBe('model_error')
  let turns = 0
  f.prepared.faux!.setResponses([
    () => {
      turns++
      return fauxAssistantMessage([fauxText(ASK)])
    },
    () => {
      turns++
      return card
    },
  ])
  // Exercise the production retry phase, not a manually tagged replacement input. Its scheduler
  // delay is already elapsed; failure detection itself belongs to watchdog's tests.
  const task = await f.opened.harness.commit(
    (tx) =>
      tx.createTask(
        f.retry!,
        {
          conversation: f.opened.root.id,
          failedTask: failure.taskId,
          recipient: f.opened.root.id,
          title: 'Automation result',
          error,
          step: 'model request',
          retried: false,
          temporary: true,
          until: 0,
        },
        { conversationId: f.opened.root.id, ownership: { kind: 'conversation' }, background: true },
      ),
    context,
  )
  await f.opened.harness.waitForTask(task, context)
  await f.opened.root.waitForIdle(context)
  const input = await f.opened.harness.commit(
    (tx) => tx.submissionByRequest(f.opened.root.id, `watchdog-retry:${failure.taskId}`),
    context,
  )
  expect(input).toMatchObject({ type: 'input', status: 'done' })
  if (input?.type !== 'input' || input.status !== 'done') throw new Error('Retry did not finish')
  const entry = await f.opened.harness.commit((tx) => tx.entry(input.entry), context)
  expect(entry?.kind).toBe('pi.user')
  expect(turns).toBe(1)
  expect((await f.log())?.messages ?? []).toHaveLength(0)
})

it('does not nudge when this conversation already has an open native card', async () => {
  const f = await fixture()
  await f.run([card])
  let turns = 0
  await f.run([
    () => {
      turns++
      return fauxAssistantMessage([fauxText(ASK)])
    },
  ])
  expect(turns).toBe(1)
  expect((await f.log())!.messages).toHaveLength(1)
})
