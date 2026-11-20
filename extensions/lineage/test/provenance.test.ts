import { AgentDoc, configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../../../server/harness.ts'
import { Family, Selection } from '../../models/api.ts'
import { Profile } from '../../subagents/api.ts'
import { seedTally } from '../../../test/helpers.ts'
import { branchFrom, fixture } from './lineage-fixture.ts'

it('records fresh branch provenance without copying selection intent or changing the source agent', async () => {
  const { server } = await fixture()
  const source = ROOT_CONVERSATION_ID
  const model = { provider: 'faux', modelId: 'faux-1' }
  const hold = { mode: 'manual' as const, model, selectedAt: 123 }
  await server.harness.commit(async (tx) => {
    await configure(tx, source, { model })
    Object.assign(await tx.doc(Selection, source), hold)
    ;(await tx.doc(Family, source)).name = 'review'
  }, context)
  await seedTally(server.harness)
  const before = await server.harness.snapshot(AgentDoc, source, context)
  expect(await server.harness.snapshot(Profile, source, context)).toBeUndefined()
  for (const choice of [{}, { model }, { model, automaticModel: true }]) {
    const id = await branchFrom(server, {
      from: source,
      prompt: 'Provenance',
      deliver: false,
      ...choice,
    })
    expect(await server.harness.snapshot(Profile, id, context)).toEqual({
      createdAt: expect.any(Number),
      ...('model' in choice && !('automaticModel' in choice) ? { explicitModel: true } : {}),
    })
    expect((await (await server.harness.conversation(id, context))!.agent(context)).model).toEqual(
      model,
    )
    expect(await server.harness.snapshot(Selection, id, context)).toBeUndefined()
    expect(await server.harness.snapshot(Family, id, context)).toEqual({
      name: 'model' in choice ? null : 'review',
    })
    expect(
      (await server.harness.commit((tx) => tx.conversation(id), context))!.owner,
    ).toBeUndefined()
  }
  expect(await server.harness.snapshot(AgentDoc, source, context)).toEqual(before)
  expect(await server.harness.snapshot(Selection, source, context)).toEqual(hold)
  expect(await server.harness.snapshot(Profile, source, context)).toBeUndefined()
  expect(await server.harness.snapshot(Family, source, context)).toEqual({ name: 'review' })
})
