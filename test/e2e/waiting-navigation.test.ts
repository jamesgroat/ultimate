import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Messages } from '../../extensions/messages/api.ts'
import { context } from '../../server/harness.ts'
import { branchProbe, fauxServer, post, removeTemp, sourceCopy, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('opens closed question threads across the Memory-to-Agent remount, wraps, repeats and navigates from To-dos', async () => {
  const home = await temp('ultimate-waiting-navigation-')
  cleanup.push(() => removeTemp(home))
  await mkdir(join(home, '.ultimate'))
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['threads'] } }),
  )
  const root = await sourceCopy(join(home, 'state'))
  await branchProbe(root)
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
    const input = transcript.messages.findLast((message) => message.role === 'user')!
    const question =
      input.role === 'user' && typeof input.content === 'string'
        ? /^Re #\d+: (alpha|beta)$/.exec(input.content)?.[1]
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
  const threads: number[] = []
  for (const content of ['alpha', 'beta']) {
    const { data: branch } = await post(server, '/api/extensions/branch-probe/actions/branch', {
      args: { from: ROOT_CONVERSATION_ID, prompt: content, deliver: false },
    })
    const id = branch.result.id as number
    threads.push(id)
    await (
      await conversation.submit({ type: 'input', content: `Re #${id}: ${content}` }, context)
    ).wait(context)
  }
  const log = await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const questions = log!.messages.filter((message) => message.to === 'user' && message.reply)
  expect(questions).toHaveLength(2)
  const entries: number[] = []
  for (const message of questions) {
    const { data: caller } = await post(server, '/api/extensions/messages/actions/caller', {
      args: { conversation: ultimate, call: message.call },
    })
    entries.push(caller.result.entry)
  }

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => {
    // oxlint-disable-next-line typescript/unbound-method -- the wrapper calls it with the original receiver below.
    const original = Element.prototype.scrollIntoView
    const revealed: { entry: string; thread: string | null }[] = []
    Object.assign(window, { revealed })
    Element.prototype.scrollIntoView = function (...args) {
      const id = this.getAttribute('data-entry-id')
      if (id)
        revealed.push({
          entry: id,
          thread: this.closest('[data-thread-pane]')?.getAttribute('data-thread-pane') ?? null,
        })
      original.apply(this, args)
    }
  })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const app = page.locator('#app')
  const count = app.locator('[data-waiting-count]')
  await count.waitFor()
  await app.locator('[data-memory-hint]').click()
  await app.getByText('What every new branch starts from').waitFor()
  const revealed = () =>
    page.evaluate(
      () =>
        (window as unknown as { revealed: { entry: string; thread: string | null }[] }).revealed,
    )
  const closeThread = async () => {
    await app
      .locator('[data-thread-pane]:not([inert])')
      .getByRole('button', { name: 'Close thread' })
      .click()
    await app.locator('[data-thread-pane]').waitFor({ state: 'detached' })
  }
  const assertReveal = async (index: number, question: number) => {
    await until(async () => (await revealed()).length > index)
    expect((await revealed())[index]).toEqual({
      entry: String(entries[question]),
      thread: String(threads[question]),
    })
    const pane = app.locator(`[data-thread-pane="${threads[question]}"]:not([inert])`)
    await pane
      .locator(`[data-entry-id="${entries[question]}"]`)
      .getByRole('button', { name: 'Dismiss' })
      .waitFor()
    expect(await revealed()).toHaveLength(index + 1)
  }
  for (const [index, question] of [0, 1, 0].entries()) {
    await count.click()
    await assertReveal(index, question)
    await closeThread()
  }
  await app.getByRole('button', { name: 'Toggle panel', exact: true }).click()
  await app.getByRole('button', { name: 'To-dos', exact: true }).click()
  await app.locator(`[data-todo-question="${questions[1].id}"] button`).click()
  await assertReveal(3, 1)
  await app
    .locator(`[data-entry-id="${entries[1]}"]`)
    .getByRole('button', { name: 'Dismiss' })
    .click()
  await until(async () => (await count.textContent()) === '1 waiting on you')
  await closeThread()
  for (const index of [4, 5]) {
    await count.click()
    await assertReveal(index, 0)
    // Leave the pane open for the repeat: the main transcript must be the only global reveal listener.
  }
})
