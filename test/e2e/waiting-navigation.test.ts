import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Roots } from '../../extensions/lineage/api.ts'
import { Messages } from '../../extensions/messages/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, sourceCopy, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('cycles to Ultimate and branch questions across surface remounts, wraps and repeats the sole question', async () => {
  const home = await temp('ultimate-waiting-navigation-')
  cleanup.push(() => removeTemp(home))
  const root = await sourceCopy(join(home, 'state'))
  const server = await fauxServer({
    ultimateRoot: root,
    projectRoot: root,
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const input = transcript.messages.findLast((message) => message.role !== 'system')!
    const text = input.role === 'user' && typeof input.content === 'string' ? input.content : ''
    if (text === 'start branch')
      return fauxAssistantMessage(
        [fauxToolCall('branch', { prompt: 'beta', root: 1, isolated: false })],
        { stopReason: 'toolUse' },
      )
    const question =
      text === 'alpha'
        ? 'alpha'
        : text.startsWith('Message from ') && text.split('\n')[1] === 'beta'
          ? 'beta'
          : undefined
    return question
      ? fauxAssistantMessage(
          [
            fauxToolCall('message', {
              to: 'user',
              text: `Question ${question}`,
              questions: [{ text: `Keep ${question}?`, kind: 'confirm' }],
            }),
          ],
          { stopReason: 'toolUse' },
        )
      : fauxAssistantMessage('Noted.')
  }
  server.host.faux!.setResponses([route])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  const tool = (await conversation.agent(context)).deferred.find(
    (candidate) => candidate.name === 'branch',
  )
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = [1]
    if (tool) await configure(tx, ultimate, { modelTools: { add: [tool] } })
  }, context)
  await (await conversation.submit({ type: 'input', content: 'alpha' }, context)).wait(context)
  await (
    await conversation.submit({ type: 'input', content: 'start branch' }, context)
  ).wait(context)
  await until(async () => {
    const log = await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
    return (
      log!.messages.filter(
        (message) => message.to === 'user' && message.reply && message.state === 'delivered',
      ).length === 2
    )
  })
  const log = await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const questions = log!.messages.filter((message) => message.to === 'user' && message.reply)
  const branch = log!.messages.find(
    (message) => message.from === ultimate && message.text === 'beta',
  )!
  expect(typeof branch.to).toBe('number')
  expect(questions.map((message) => message.from)).toEqual([ultimate, branch.to])
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const app = page.locator('#app')
  const count = app.locator('[data-waiting-count]')
  await count.waitFor()
  const memory = async () => {
    await app.locator('[data-memory-hint]').click()
    await app.getByText('What every new branch starts from').waitFor()
  }
  const assertReveal = async (question: number) => {
    const asked = questions[question]
    await until(
      async () => new URL(page.url()).searchParams.get('conversation') === String(asked.from),
    )
    await app
      .locator(`[data-message-outgoing="${asked.id}"]`)
      .getByRole('button', { name: 'Dismiss', exact: true })
      .waitFor()
    // Upstream reveals through scrollTop, not scrollIntoView: observe the question below the pinned strip.
    const gap = () =>
      page.evaluate((id) => {
        const card = document.querySelector(`[data-message-outgoing="${id}"]`)
        const strip = document.querySelector('[data-ui="pinned-prompt"]')
        return card && strip
          ? card.getBoundingClientRect().top - strip.getBoundingClientRect().bottom
          : Number.NaN
      }, asked.id)
    await until(async () => Math.abs((await gap()) - 8) < 4)
    expect(Math.abs((await gap()) - 8)).toBeLessThan(4)
  }
  for (const question of [0, 1, 0]) {
    await memory()
    await count.click()
    await assertReveal(question)
    if (question === 1) {
      // The row's center is under the separate count control; click its leading mark instead.
      // The rest of the row opens Ultimate from a branch, without advancing the cycle.
      await app
        .locator('[data-standing="ultimate"] > button[aria-labelledby]')
        .click({ position: { x: 12, y: 12 } })
      await until(
        async () => new URL(page.url()).searchParams.get('conversation') === String(ultimate),
      )
    }
  }
  await count.click()
  await assertReveal(1)
  await app
    .locator(`[data-message-outgoing="${questions[1].id}"]`)
    .getByRole('button', { name: 'Dismiss', exact: true })
    .click()
  await until(async () => (await count.textContent()) === '1 waiting on you')
  await memory()
  await count.click()
  await assertReveal(0)
  const card = app.locator(`[data-message-outgoing="${questions[0].id}"]`)
  const top = (await card.boundingBox())!.y
  await card.hover()
  await page.mouse.wheel(0, -600)
  await until(async () => (await card.boundingBox())!.y - top > 40)
  expect((await card.boundingBox())!.y - top).toBeGreaterThan(40)
  await count.click()
  await assertReveal(0)
})
