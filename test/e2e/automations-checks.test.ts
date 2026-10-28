import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { afterEach, expect, it } from 'vitest'
import { Automations } from '../../extensions/automations/server.ts'
import type { Automation } from '../../extensions/automations/types.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, temp, until } from '../helpers.ts'

let server: Awaited<ReturnType<typeof fauxServer>> | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function fixture() {
  const root = await temp('ultimate-checks-')
  const userHome = join(root, 'user')
  const home = join(root, 'home')
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  for (const name of ['watcher', 'ultimate'])
    await writeFile(
      join(userHome, '.ultimate/agents', `${name}.md`),
      `---\nname: ${name}\ndescription: Test\nmodel: faux/faux-1\nsummaries: false\ntools: []\n${name === 'ultimate' ? 'resident: true\n' : ''}---\nTest\n`,
    )
  const options = {
    ultimateRoot: resolve('.'),
    projectRoot: root,
    userHome,
    home,
    localSetup: true,
  }
  const app = (server = await fauxServer(options))
  const calls: string[] = []
  const held: { text: string; release: () => void }[] = []
  const route: FauxResponseFactory = async (transcript, request) => {
    app.host.faux!.appendResponses([route])
    const last = transcript.messages.findLast((m) => m.role === 'user')!
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    calls.push(text)
    if (text.includes('You own automation') || text.includes('Investigate, fix run')) {
      const gate = Promise.withResolvers<void>()
      held.push({ text, release: gate.resolve })
      await Promise.race([
        gate.promise,
        new Promise((_, reject) =>
          request?.signal?.addEventListener('abort', () => reject(new Error('closed')), {
            once: true,
          }),
        ),
      ])
    }
    return fauxAssistantMessage('Unable to repair.')
  }
  app.host.faux!.setResponses([route])
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const invoke = (action: string, args: JsonValue) =>
    app.extensions.invoke('automations', action, args, new AbortController().signal, caller.id)
  const get = async (id: string) =>
    (await app.harness.snapshot(Automations, context))!.automations[id]
  const folder = (id: string) => join(userHome, '.ultimate/automations', basename(home), id)
  const script = async (id: string, body: string) => {
    await mkdir(join(folder(id), 'state'), { recursive: true })
    await writeFile(join(folder(id), 'run'), `#!/bin/sh\n${body}\n`)
    await chmod(join(folder(id), 'run'), 0o700)
  }
  const entries = async (id: number, kind: string) =>
    (
      await (await app.harness.conversation(id as ConversationId, context))!.context(context)
    ).entries.filter((e) => e.conversationId === id && e.kind === kind)
  const deliveriesSettled = () =>
    app.harness.commit(
      async (tx) =>
        (await tx.scanTasks({ kind: 'ultimate.automation-delivery' }, 100)).items.every(
          (t) => t.state.status === 'terminal',
        ),
      context,
    )
  const create = async (schedule?: string, extra = {}) => {
    const a = (await invoke('create', {
      name: 'Check',
      ask: 'Check for changes',
      ...(schedule ? { schedule } : {}),
      ...extra,
    })) as Automation
    await until(() => held.some((h) => h.text.includes(`You own automation ${a.id} `)))
    return a
  }
  const releaseWriting = async (a: Automation) => {
    held.find((h) => h.text.includes(`You own automation ${a.id} `))!.release()
    await (await app.harness.conversation(
      a.script!.conversationId as ConversationId,
      context,
    ))!.waitForIdle(context)
  }
  return {
    app,
    options,
    calls,
    held,
    caller,
    invoke,
    get,
    folder,
    script,
    entries,
    deliveriesSettled,
    create,
    releaseWriting,
  }
}

it('checks quietly with zero model calls, then delivers FIRE and its prompt through the shared path', async () => {
  const f = await fixture()
  const a = await f.create('every 1s', { prompt: 'Summarize changes', subscribers: [f.caller.id] })
  await f.script(a.id, 'exit 0')
  await f.invoke('resume', { id: a.id })
  await f.releaseWriting(a)
  const baseline = [...f.calls]
  await until(async () => (await f.get(a.id)).script!.check?.result === 'quiet')
  expect(f.calls).toEqual(baseline)
  expect(await f.get(a.id)).toMatchObject({
    enabled: true,
    fires: 0,
    runs: [],
    script: { state: 'running', timeout: 300, check: { result: 'quiet' } },
  })
  expect(await f.entries(f.caller.id, 'automations.fired')).toHaveLength(0)
  await f.script(a.id, 'echo FIRE changed; echo FIRE ignored')
  await until(async () => (await f.get(a.id)).runs[0]?.status === 'done')
  await until(async () => (await f.entries(f.caller.id, 'automations.fired')).length === 1)
  expect(await f.get(a.id)).toMatchObject({
    enabled: false,
    fires: 1,
    script: { state: 'done', check: { result: 'fired', fired: 1 } },
  })
  expect((await f.entries(f.caller.id, 'automations.fired'))[0].data).toMatchObject({
    text: 'changed',
  })
  expect(f.calls.filter((text) => text.includes('Summarize changes'))).toEqual([
    'Summarize changes\n\nFired: changed',
  ])
})

it.each([undefined, 'every 1h'])(
  'escalates consecutive failures through the common finish path (%s)',
  async (schedule) => {
    const f = await fixture()
    const a = await f.create(schedule, { once: false })
    await f.script(a.id, 'exit 7')
    if (schedule) await f.invoke('resume', { id: a.id })
    for (const failures of [1, 2, 3]) {
      await f.invoke(schedule ? 'run' : 'resume', { id: a.id })
      await until(async () => (await f.get(a.id)).script!.failures === failures)
    }
    await until(async () => (await f.entries(f.caller.id, 'automations.escalated')).length === 1)
    expect(await f.get(a.id)).toMatchObject({
      enabled: false,
      script: {
        failures: 3,
        state: 'failed',
        error: 'Failed 3 times in a row: Process exited with code 7',
      },
    })
    await until(f.deliveriesSettled)
    // Failure inputs can still be queued behind the held writing turn.
    const failed = await f.app.harness.commit(
      async (tx) =>
        (await tx.scanTasks({ kind: 'ultimate.automation-delivery' }, 100)).items.filter(
          (t) => (t.input as { kind: string }).kind === 'failed',
        ),
      context,
    )
    expect(failed).toHaveLength(2)
    expect(await f.entries(f.caller.id, 'automations.failed')).toHaveLength(0)
  },
)

it.each([undefined, 'every 1h'])(
  'escalates a final watcher yield after the failure delivery has settled (%s)',
  async (schedule) => {
    const f = await fixture()
    const a = await f.create(schedule, { once: false })
    await f.script(a.id, 'sleep 0.2; exit 9')
    await f.invoke('resume', { id: a.id })
    await f.releaseWriting(a)
    if (schedule) await f.invoke('run', { id: a.id })
    await until(() => f.held.some((h) => h.text.includes('Investigate, fix run')))
    await until(f.deliveriesSettled)
    expect(await f.get(a.id)).toMatchObject({ script: { state: 'investigating', failures: 1 } })
    // A bounded failure is disabled while the same watcher investigates it.
    expect((await f.get(a.id)).enabled).toBe(!schedule)
    expect(await f.entries(f.caller.id, 'automations.escalated')).toHaveLength(0)
    f.held.find((h) => h.text.includes('Investigate, fix run'))!.release()
    await until(async () => (await f.entries(f.caller.id, 'automations.escalated')).length === 1)
    expect(await f.get(a.id)).toMatchObject({
      enabled: false,
      script: {
        state: 'failed',
        error: 'The watcher stopped while the script was investigating: Unable to repair.',
      },
    })
  },
)

it('counts pre-spawn failures after an older quiet check instead of treating idle time as healthy runtime', async () => {
  const f = await fixture()
  const a = await f.create('every 1h', { once: false })
  await f.script(a.id, 'exit 0')
  await f.invoke('resume', { id: a.id })
  await f.releaseWriting(a)
  await f.invoke('run', { id: a.id })
  await until(async () => (await f.get(a.id)).script!.check?.result === 'quiet')
  await f.app.harness.commit(async (tx) => {
    const saved = (await tx.doc(Automations)).automations[a.id]
    saved.script!.startedAt = Date.now() - 3600001
  }, context)
  await chmod(join(f.folder(a.id), 'run'), 0o600)
  for (const failures of [1, 2, 3]) {
    await f.invoke('run', { id: a.id })
    await until(async () => {
      const saved = await f.get(a.id)
      return saved.scheduler === undefined && saved.script!.check?.result === 'failed'
    })
    expect((await f.get(a.id)).script!.failures).toBe(failures)
  }
  expect(await f.get(a.id)).toMatchObject({
    enabled: false,
    script: { failures: 3, state: 'failed' },
  })
  await until(async () => (await f.entries(f.caller.id, 'automations.escalated')).length === 1)
})

it('replays a running check after facet reload', async () => {
  const f = await fixture()
  const a = await f.create('every 1h', { once: false })
  await f.script(
    a.id,
    'echo start >> "$AUTOMATION_STATE/starts"; if [ ! -e "$AUTOMATION_STATE/started" ]; then touch "$AUTOMATION_STATE/started"; echo waiting; sleep 60; fi',
  )
  await f.invoke('resume', { id: a.id })
  await f.invoke('run', { id: a.id })
  await until(async () =>
    ((await f.invoke('log', { id: a.id })) as { text: string }).text.includes('waiting'),
  )
  const before = await f.get(a.id)
  const file = join(f.app.host.ultimateRoot, 'extensions/automations/supervisor.ts')
  const source = await readFile(file, 'utf8')
  const loaded = () =>
    f.app.extensions.info().find((e) => e.name === 'automations')!.server!.loadedAt
  const previous = loaded()
  await writeFile(file, source + '\n')
  f.app.vite.watcher.emit('change', file)
  await until(() => loaded() !== previous)
  await until(async () => (await f.get(a.id)).script!.check?.result === 'quiet')
  expect((await f.get(a.id)).scheduler).toBe(before.scheduler)
  expect(
    (await readFile(join(f.folder(a.id), 'state/starts'), 'utf8')).trim().split('\n'),
  ).toHaveLength(2)
  expect((await f.get(a.id)).enabled).toBe(true)
  expect((await f.get(a.id)).script!.failures).toBeUndefined()
})

it('replays an unfinished check after shutdown with the same scheduler and persistent state', async () => {
  const f = await fixture()
  const a = await f.create('every 1h', { once: false })
  await f.script(
    a.id,
    'echo start >> "$AUTOMATION_STATE/starts"; if [ ! -e "$AUTOMATION_STATE/started" ]; then touch "$AUTOMATION_STATE/started"; echo waiting; sleep 60; fi',
  )
  await f.invoke('resume', { id: a.id })
  await f.invoke('run', { id: a.id })
  await until(async () =>
    ((await f.invoke('log', { id: a.id })) as { text: string }).text.includes('waiting'),
  )
  const before = await f.get(a.id)
  await f.app.close()
  server = undefined
  const app = (server = await fauxServer(f.options))
  const get = async () => (await app.harness.snapshot(Automations, context))!.automations[a.id]
  await until(async () => (await get()).script!.check?.result === 'quiet')
  expect((await get()).scheduler).toBe(before.scheduler)
  expect((await get()).enabled).toBe(true)
  expect(
    (await readFile(join(f.folder(a.id), 'state/starts'), 'utf8')).trim().split('\n'),
  ).toHaveLength(2)
  expect((await get()).script!.failures).toBeUndefined()
})
