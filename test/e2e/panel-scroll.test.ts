// A long to-do list once scrolled the whole page: each to-do's checkbox renders a visually hidden absolute input, and
// with no positioned ancestor up to the body those inputs sat at their rows' offsets in the document, so the page grew
// by the list's full height although the panel itself scrolled.
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { fauxServer, post, removeTemp, temp } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('keeps a long to-do list scrolling inside its panel, never the page', async () => {
  const home = await temp('ultimate-panel-scroll-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  for (let n = 1; n <= 40; n++)
    await post(server, '/api/extensions/todos/actions/add', {
      args: {
        text: `To-do ${n}: ${'a long line of text that wraps over several rows in the panel '.repeat(2)}`,
        owner: n % 2 ? 'user' : 'ultimate',
      },
    })

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(server.url)
  const header = page.locator('[data-ui="conversation-header"]')
  await header.waitFor()
  await header.getByRole('button', { name: 'Toggle panel' }).click()
  await page.locator('[data-todo="40"]').waitFor()
  const heights = await page.evaluate(() => {
    const list = document.querySelector('[data-todos]')!
    return {
      page: document.scrollingElement!.scrollHeight - innerHeight,
      list: list.scrollHeight > innerHeight,
    }
  })
  expect(heights).toEqual({ page: 0, list: true })
})
