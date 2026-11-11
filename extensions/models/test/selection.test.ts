import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { AgentDoc, configure } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { Profile } from '../../subagents/api.ts'
import { Family, Selection } from '../api.ts'
import { fauxServer, post, removeTemp, sourceCopy, temp } from '../../../test/helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
const homes: string[] = []
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()))
  for (const home of homes) await removeTemp(home)
})

async function fixture(policy = '') {
  const home = await temp('model-selection-')
  homes.push(home)
  const root = await sourceCopy(home)
  await rm(join(root, '.ultimate/agents/coordinator.md'))
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  const file = join(home, '.ultimate/agents/dice.md')
  await writeFile(file, definition('Original'))
  await writeFile(join(root, '.ultimate/settings.json'), JSON.stringify({ summaryModel: 'off' }))
  if (policy) {
    const plugin = join(root, 'extensions/input-policy')
    await mkdir(plugin)
    await writeFile(join(plugin, 'README.md'), 'Transactional input policy test.')
    await writeFile(
      join(plugin, 'server.ts'),
      `
      import { AgentDoc, defineExtension } from '@earendil-works/pi-durable'
      import { BeforeInput, Family, Selection } from '../models/api.ts'
      export default (host) => {
        host.implement(BeforeInput, { async beforeInput(tx, id) { ${policy} } })
        return defineExtension({ name: 'input-policy' })
      }
    `,
    )
  }
  const open = async () => {
    const server = await fauxServer({
      ultimateRoot: root,
      home: join(home, 'state'),
      userHome: home,
      faux: fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-think', reasoning: true }] }),
    })
    servers.push(server)
    return server
  }
  const server = await open()
  const standing = async (current = server) => {
    const response = await post(current, '/api/extensions/subagents/actions/standing', {
      args: { name: 'dice' },
    })
    expect(response.status).toBe(200)
    return response.data.result as ConversationId
  }
  return { server, file, open, standing }
}
const definition = (body: string, extra = '') =>
  `---\nname: dice\ndescription: Dice\nresident: true\n${extra}---\n${body}`
const model = { provider: 'faux', modelId: 'faux-1' }

it('records even a same-model manual pick, clears its old family, and preserves manual/Auto choices on reopen and refresh', async () => {
  const f = await fixture()
  const id = await f.standing()
  await f.server.harness.commit((tx) => configure(tx, id, { model }), context)
  // Upstream creates residents on open; refreshing the existing resident reads the empty intent document.
  expect(await f.server.harness.snapshot(Selection, id, context)).toEqual({})
  expect(await f.server.harness.snapshot(Family, id, context)).toEqual({ name: 'default' })
  const response = await post(f.server, '/api/extensions/models/actions/select', {
    conversationId: id,
    args: { model },
  })
  expect(response.status).toBe(200)
  const intent = await f.server.harness.snapshot(Selection, id, context)
  expect(intent).toEqual({ mode: 'manual', model, selectedAt: expect.any(Number) })
  expect(await f.server.harness.snapshot(Family, id, context)).toEqual({ name: null })
  await writeFile(f.file, definition('Pinned', 'model: faux/faux-think\nthinking: high\n'))
  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  const reopened = await f.open()
  expect(await reopened.harness.snapshot(Selection, id, context)).toEqual(intent)
  for (const mode of ['manual', 'auto'] as const) {
    await reopened.harness.commit(async (tx) => {
      ;(await tx.doc(Selection, id)).mode = mode
    }, context)
    expect(await f.standing(reopened)).toBe(id)
    expect(await reopened.harness.snapshot(AgentDoc, id, context)).toMatchObject({
      model,
      thinkingLevel: 'off',
      instructions: 'Pinned',
    })
    expect(await reopened.harness.snapshot(Family, id, context)).toEqual({ name: null })
  }
})

it('selects family, model and thinking atomically and keeps the chosen family across definition refreshes', async () => {
  const f = await fixture()
  const id = await f.standing()
  const chosen = { provider: 'faux', modelId: 'faux-think' }
  const response = await post(f.server, '/api/extensions/models/actions/select', {
    conversationId: id,
    args: { model: chosen, family: 'review', thinkingLevel: 'high' },
  })
  expect(response.status).toBe(200)
  await writeFile(f.file, definition('Changed', 'model: faux/faux-1\n'))
  await f.standing()
  expect(await f.server.harness.snapshot(AgentDoc, id, context)).toMatchObject({
    model: chosen,
    thinkingLevel: 'high',
  })
  expect(await f.server.harness.snapshot(Family, id, context)).toEqual({ name: 'review' })
  expect(await f.server.harness.snapshot(Selection, id, context)).toMatchObject({
    mode: 'manual',
    model: chosen,
  })
  const before = await f.server.harness.snapshot(Selection, id, context)
  const invalid = await post(f.server, '/api/extensions/models/actions/select', {
    conversationId: id,
    args: { model, thinkingLevel: 'high' },
  })
  expect(invalid.status).toBe(500)
  expect(invalid.data.error).toBe('Unsupported thinking level')
  expect(await f.server.harness.snapshot(Selection, id, context)).toEqual(before)
  expect(await f.server.harness.snapshot(Family, id, context)).toEqual({ name: 'review' })
})

it('runs optional policy before the independent login fallback in the input transaction', async () => {
  const f = await fixture(`
    (await tx.doc(Selection, id)).mode = 'auto'
    ;(await tx.doc(AgentDoc, id)).model = { provider: 'anthropic', modelId: 'claude-opus-5.5' }
  `)
  await writeFile(f.file, definition('Pinned', 'model: faux/faux-1\n'))
  const id = await f.standing()
  f.server.host.faux!.setResponses([fauxAssistantMessage('Policy applied')])
  const conversation = (await f.server.harness.conversation(id, context))!
  await (
    await conversation.submit({ type: 'input', content: 'Policy input' }, context)
  ).wait(context)
  expect(await f.server.harness.snapshot(Selection, id, context)).toEqual({ mode: 'auto' })
  const entries = await f.server.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: id }, 100)).items,
    context,
  )
  expect(
    entries.filter((entry) => entry.kind === 'models.fallback').map((entry) => entry.data),
  ).toEqual([{ from: 'anthropic/claude-opus-5.5', to: 'faux/faux-1', reason: 'pin' }])
  expect(await f.server.harness.snapshot(Family, id, context)).toEqual({ name: null })
  expect(await f.server.harness.snapshot(Profile, id, context)).toEqual({ definition: 'dice' })
})
