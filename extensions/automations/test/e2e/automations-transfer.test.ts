import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { requestChapter } from '../../../../lib/chapters.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, temp } from '../../../../test/helpers.ts'
import { Automations } from '../../server.ts'
import type { Automation } from '../../types.ts'
import type { ScriptTransfer } from '../../api.ts'

let server: Awaited<ReturnType<typeof fauxServer>> | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

it('transfers scheduled and continuous scripts with preserved PR and changelog state, without a writing turn or replay on reopen', async () => {
  const root = await temp('ultimate-transfer-')
  const userHome = join(root, 'user')
  const home = join(root, 'home')
  const extension = join(root, '.ultimate/extensions/transfer-test')
  await mkdir(extension, { recursive: true })
  await writeFile(
    join(extension, 'server.ts'),
    `
import { AutomationsApi } from '${resolve('extensions/automations/api.ts')}'
import { SubagentsApi } from '${resolve('extensions/subagents/api.ts')}'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
export default function(host) { host.need(AutomationsApi); host.need(SubagentsApi); return { name: 'transfer-test' } }
export const actions = {
  standing: (_, {host}) => host.need(SubagentsApi).standing('ultimate', BACKGROUND_CONTEXT),
  retire: (chapter, {host}) => host.need(AutomationsApi).retireScripts(chapter),
  adopt: ({transfer, key}, {host}) => host.need(AutomationsApi).adoptScript(transfer, key),
}
`,
  )
  const definitions = join(userHome, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  for (const name of ['ultimate', 'watcher'])
    await writeFile(
      join(definitions, `${name}.md`),
      `---\nname: ${name}\ndescription: Test\nmodel: faux/faux-1\ntools: []\n${name === 'ultimate' ? 'resident: true\n' : ''}---\nTest\n`,
    )
  const options = { ultimateRoot: resolve('.'), projectRoot: root, home, userHome }
  const open = async () => {
    server = await fauxServer(options)
    return server
  }
  let app = await open()
  const invoke = (action: string, args: unknown) =>
    app.extensions.invoke(
      'transfer-test',
      action,
      JSON.parse(JSON.stringify(args)),
      new AbortController().signal,
    )
  const ultimate = (await invoke('standing', null)) as ConversationId
  const scripts = ['prs.json', 'seen-ids.json']
  const body = '#!/bin/sh\nwhile :; do sleep 60; done\n'
  for (const [index, file] of scripts.entries()) {
    const id = `A${index + 10}`
    const dir = join(userHome, '.ultimate/automations', basename(home), id)
    await mkdir(join(dir, 'state'), { recursive: true })
    await writeFile(join(dir, 'run'), body)
    await chmod(join(dir, 'run'), 0o700)
    await writeFile(join(dir, 'state', file), '{"already-seen":[290,291]}\n')
    await app.harness.commit(async (tx) => {
      const ledger = await tx.doc(Automations)
      ledger.next = index + 11
      const watcher = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      ledger.automations[id] = {
        id,
        name: file,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        ...(index === 0 ? { schedule: { kind: 'every', ms: 86400000 } as const } : {}),
        script: {
          ask: 'Watch updates',
          once: false,
          secrets: index === 0 ? ['TEST_SECRET'] : [],
          conversationId: watcher.id,
          state: 'running',
          ...(index === 0 ? { timeout: 42 } : {}),
        },
        subscribers: [ultimate],
        prompt: 'Handle updates',
        model: { provider: 'faux', modelId: 'faux-1' },
        thinking: 'low',
        runs: [],
        fires: 0,
      }
    }, context)
  }
  await app.extensions.invoke('automations', 'resume', { id: 'A11' }, new AbortController().signal)
  const transfers = (await invoke('retire', 'next')) as ScriptTransfer[]
  expect(transfers).toHaveLength(2)
  expect(transfers.map((t) => t.error)).toEqual([undefined, undefined])
  expect(transfers[0].subscribers).toEqual(['@ultimate'])
  await app.close()
  server = undefined
  await requestChapter(home, 'next')
  app = await open()
  const adopted: Automation[] = []
  for (const transfer of transfers) {
    const key = `seed:the-beginning:${transfer.id}`
    const a = (await invoke('adopt', { transfer, key })) as Automation
    adopted.push(a)
    expect(a.script!.state).toBe('running')
    expect(a.prompt).toBe('Handle updates')
    expect(a.model).toEqual(transfer.automation.model)
    expect(a.thinking).toBe('low')
    const dir = join(userHome, '.ultimate/automations', `${basename(home)}@next`, a.id)
    expect(await readFile(join(dir, 'run'), 'utf8')).toBe(body)
    expect(await readFile(join(dir, 'state', a.name), 'utf8')).toBe('{"already-seen":[290,291]}\n')
    const entries = await (await app.harness.conversation(
      a.script!.conversationId,
      context,
    ))!.context(context)
    expect(entries.entries.filter((e) => e.kind === 'automations.writing')).toEqual([])
  }
  expect(adopted[0].script!.timeout).toBe(42)
  expect(adopted[0].script!.secrets).toEqual(['TEST_SECRET'])
  const changed = join(
    userHome,
    '.ultimate/automations',
    `${basename(home)}@next`,
    adopted[1].id,
    'state',
    'seen-ids.json',
  )
  await writeFile(changed, 'new observation\n')
  await app.close()
  server = undefined
  app = await open()
  for (const transfer of transfers) {
    const a = (await invoke('adopt', {
      transfer,
      key: `seed:the-beginning:${transfer.id}`,
    })) as Automation
    expect(a.id).toBe(adopted.find((item) => item.name === a.name)!.id)
  }
  expect(await readFile(changed, 'utf8')).toBe('new observation\n')
  expect(
    Object.values((await app.harness.snapshot(Automations, context))!.automations).filter((a) =>
      a.key?.startsWith('seed:the-beginning:'),
    ),
  ).toHaveLength(2)
  await app.close()
  server = undefined
  await requestChapter(home, 'the-beginning')
  app = await open()
  for (const transfer of transfers) {
    const a = (await app.harness.snapshot(Automations, context))!.automations[transfer.id]
    expect(a.enabled).toBe(false)
    expect(a.retiredTo).toBe('next')
    await expect(
      app.extensions.invoke('automations', 'resume', { id: a.id }, new AbortController().signal),
    ).rejects.toThrow('retired')
    expect(await readFile(transfer.source, 'utf8')).toBe(body)
  }
})
