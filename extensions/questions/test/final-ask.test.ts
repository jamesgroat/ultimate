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
import { ClassifyApi } from '../../classify/api.ts'
import type { ClassifyService } from '../../classify/api.ts'

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
  options: {
    off?: boolean
    noMessage?: boolean
    restart?: boolean
    retry?: boolean
    classify?: ClassifyService['ask']
  } = {},
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
    want: (api: unknown) =>
      api === ClassifyApi && options.classify ? { ask: options.classify } : undefined,
    need: (api: Parameters<typeof idleNeed>[0]) =>
      api.name === 'subagents' ? { residents: async () => [] } : idleNeed(api),
    conversations: () => [],
    projects: async () => [],
    doc: () => undefined,
    projectSettings: async () => ({}),
    onOpen: () => {},
    react: () => {},
  } as unknown as ExtensionHost
  const backend = messages(host)
  prepared.registry.install(options.noMessage ? { ...backend, tools: [] } : backend)
  prepared.registry.install(questions(host))
  const retry = options.retry
    ? (watchdog({ ...host, onOpen: () => {}, onClose: () => {} }).tasks![0] as Task<
        JsonValue,
        { phase: string },
        null,
        object
      >)
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

const OTHER_ASK =
  'Should I rotate the Sentry FTP credential tonight, or leave the release pipeline as it is?'

it('nudges an ask that an open card about something else does not cover', async () => {
  const f = await fixture()
  await f.run([card])
  let turns = 0
  await f.run([
    () => {
      turns++
      return fauxAssistantMessage([fauxText(OTHER_ASK)])
    },
    () => {
      turns++
      return card
    },
  ])
  expect(turns).toBe(2)
})

it('lets the classifier judge coverage, and the word overlap decide when it fails', async () => {
  const covers = (p: number) => async (request: { questions: object }) => ({
    model: 'fake',
    answers: Object.fromEntries(
      Object.keys(request.questions).map((key) => [
        key,
        { type: 'noul' as const, noul: key === 'ask' ? 0.95 : p },
      ]),
    ),
    usage: { inputTokens: 0 },
  })
  for (const [classify, ask, expected] of [
    [covers(0.9), OTHER_ASK, 1],
    [covers(0.1), ASK, 2],
    [async () => Promise.reject(new Error('402')), ASK, 1],
    [async () => Promise.reject(new Error('402')), OTHER_ASK, 2],
  ] as const) {
    const f = await fixture({ classify })
    await f.run([card])
    let turns = 0
    await f.run([
      () => {
        turns++
        return fauxAssistantMessage([fauxText(ask)])
      },
      () => {
        turns++
        return card
      },
    ])
    expect(turns).toBe(expected)
  }
})

const SK_MISS =
  'Two ways forward.\n- **Build now:** go ahead with steps 1–3 (parser, card, tests)?\n- **Wait:** hold for the API.'
const noul = (p: number) => async () => ({
  model: 'fake',
  answers: { ask: { type: 'noul' as const, noul: p } },
  usage: { inputTokens: 0 },
})

it('nudges an ask only the classifier catches, and leaves one it scores low alone', async () => {
  for (const [p, expected] of [
    [0.93, 2],
    [0.4, 1],
  ] as const) {
    const states: unknown[] = []
    const f = await fixture({
      classify: async (request, signal) => {
        states.push(request.state)
        expect(signal).toBeInstanceOf(AbortSignal)
        return noul(p)()
      },
    })
    let turns = 0
    await f.run([
      () => {
        turns++
        return fauxAssistantMessage([fauxText(SK_MISS + '\n```\nsecret code\n```\n> quoted')])
      },
      () => {
        turns++
        return card
      },
    ])
    expect(turns).toBe(expected)
    expect(states).toHaveLength(1)
    expect(states[0]).toEqual({ tail: SK_MISS.replaceAll('**', '') })
  }
})

it('sends only the closing paragraphs, so soft offers count and a long plan does not', async () => {
  const filler = Array.from(
    { length: 6 },
    (_, i) => `Finding ${i}: ${'the tile reads the cached Walmart row and shows it. '.repeat(6)}`,
  )
  const opening = 'Here is the review of the Send to WFS idea, in three parts.'
  for (const [closing, expected] of [
    ['Happy to start the branch whenever you want.', 2],
    ["If you end up telling me to take the registry approach, I'll rework the branch tonight.", 2],
    ['Next I run the live probe, then build the tile and land it.', 1],
  ] as const) {
    const states: { head?: string; tail: string }[] = []
    const f = await fixture({
      classify: async (request) => {
        const state = request.state as { head?: string; tail: string }
        states.push(state)
        return noul(/happy to|end up telling me/i.test(state.tail) ? 0.95 : 0.1)()
      },
    })
    let turns = 0
    await f.run([
      () => {
        turns++
        return fauxAssistantMessage([fauxText([opening, ...filler, closing].join('\n\n'))])
      },
      () => {
        turns++
        return card
      },
    ])
    expect(turns).toBe(expected)
    expect(states).toHaveLength(1)
    expect(states[0].head).toBe(opening)
    expect(states[0].tail.length).toBeLessThanOrEqual(800)
    expect(states[0].tail.endsWith(closing)).toBe(true)
    expect(states[0].tail).not.toContain('Finding 3')
  }
})

it('falls back to the regex when classify is unavailable, failing or slow', async () => {
  const never = () => new Promise<never>(() => {})
  for (const classify of [undefined, async () => Promise.reject(new Error('402')), never]) {
    const f = await fixture(classify ? { classify } : {})
    let turns = 0
    const started = Date.now()
    await f.run([
      () => {
        turns++
        return fauxAssistantMessage([fauxText(SK_MISS)])
      },
    ])
    expect(turns).toBe(1)
    expect(Date.now() - started).toBeLessThan(6_000)
  }
  const f = await fixture({ classify: never })
  let turns = 0
  await f.run([
    () => {
      turns++
      return fauxAssistantMessage([fauxText(ASK)])
    },
    () => {
      turns++
      return card
    },
  ])
  expect(turns).toBe(2)
})
