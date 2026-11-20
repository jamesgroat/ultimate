// A wide touch screen, such as an iPad in landscape, is as wide as a desktop window, but a panel docked beside the
// sidebar leaves the conversation too narrow to read on it: there the sidebar docks and the panel overlays. A
// touch-screen laptop is driven by its trackpad, so its primary pointer is fine and it keeps the desktop layout.
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { fauxServer, removeTemp, temp } from '../helpers.ts'

let home: string
let server: Awaited<ReturnType<typeof fauxServer>>
let browser: Browser
let touchLaptop: Browser

beforeAll(async () => {
  home = await temp('ultimate-touch-tablet-')
  server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  const launch = async (args: string[]) =>
    chromium.launch({
      executablePath: await browserBinary(),
      headless: true,
      args,
      env: { ...process.env, TMPDIR: undefined },
    })
  browser = await launch([])
  // Blink's pointer bit flags: 2 is coarse and 4 is fine, so a fine primary pointer with a touch screen beside it.
  touchLaptop = await launch(['--blink-settings=primaryPointerType=4,availablePointerTypes=6'])
})

afterAll(async () => {
  await browser?.close()
  await touchLaptop?.close()
  await server?.close()
  await removeTemp(home)
})

async function layout(on: Browser, hasTouch: boolean) {
  const page = await on.newPage({ viewport: { width: 1180, height: 820 }, hasTouch })
  await page.goto(server.url)
  const pointer = await page.evaluate(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    anyCoarse: matchMedia('(any-pointer: coarse)').matches,
  }))
  const header = page.locator('[data-ui="conversation-header"]')
  await header.waitFor()
  await header.getByRole('button', { name: 'Toggle panel' }).click()
  // An overlay panel stays in the page while closed, translated off screen, so wait until it has slid in.
  await page.waitForFunction(() => {
    const panel = document.querySelector('aside.border-l')
    return panel !== null && panel.getBoundingClientRect().right <= innerWidth
  })
  await page.waitForFunction(() => document.getAnimations().length === 0)
  const regions = await page.evaluate(() => {
    const region = (selector: string) => {
      const aside = document.querySelector(selector)!
      const { left, right } = aside.getBoundingClientRect()
      return { overlay: aside.closest('.fixed') !== null, left, right }
    }
    const conversation = document.querySelector('[data-ui="conversation-header"]')!
    const { left, right } = conversation.getBoundingClientRect()
    return {
      sidebar: region('aside.border-r'),
      panel: region('aside.border-l'),
      conversation: { left, right },
    }
  })
  await page.close()
  return { pointer, ...regions }
}

it('keeps a wide touch screen in the tablet layout: the sidebar docks and the panel overlays', async () => {
  const { pointer, sidebar, panel, conversation } = await layout(browser, true)
  expect(pointer).toEqual({ coarse: true, anyCoarse: true })
  expect(sidebar).toMatchObject({ overlay: false, left: 0 })
  expect(conversation.left).toBe(sidebar.right)
  expect(panel).toMatchObject({ overlay: true, right: 1180 })
  expect(conversation.right).toBe(1180)
})

it('docks both the sidebar and the panel in a window of the same size without touch', async () => {
  const { pointer, sidebar, panel, conversation } = await layout(browser, false)
  expect(pointer).toEqual({ coarse: false, anyCoarse: false })
  expect(sidebar).toMatchObject({ overlay: false, left: 0 })
  expect(conversation.left).toBe(sidebar.right)
  expect(panel).toMatchObject({ overlay: false, right: 1180 })
  expect(conversation.right).toBe(panel.left)
})

it('docks both on a touch-screen laptop whose primary pointer is its trackpad', async () => {
  const { pointer, sidebar, panel, conversation } = await layout(touchLaptop, false)
  expect(pointer).toEqual({ coarse: false, anyCoarse: true })
  expect(sidebar).toMatchObject({ overlay: false, left: 0 })
  expect(conversation.left).toBe(sidebar.right)
  expect(panel).toMatchObject({ overlay: false, right: 1180 })
  expect(conversation.right).toBe(panel.left)
})
