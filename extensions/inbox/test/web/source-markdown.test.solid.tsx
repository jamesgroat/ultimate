/** @jsxImportSource @solidjs/web */
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const installed = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  let records: unknown[] = []
  return {
    get: () => records,
    subscribe: (listener: () => void) => (
      listeners.add(listener),
      () => listeners.delete(listener)
    ),
    set(next: unknown[]) {
      records = next
      for (const listener of listeners) listener()
    },
  }
})
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    uiState: createUiState(undefined),
    api: {},
    registry: { getSnapshot: installed.get, subscribe: installed.subscribe },
  }
})

import { Markdown } from '../../../../web/src/components/markdown/markdown.solid.tsx'
import type { MarkdownOrigin } from '../../../../web/src/components/markdown/source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

beforeEach(() => {
  installed.set([
    {
      name: 'local',
      version: 1,
      extension: {
        link: (props: { href: string }) => <span data-local-link={props.href} />,
        inlineCode: () => <span data-local-inline />,
        codeBlocks: { text: () => <span data-local-block /> },
      },
    },
  ])
})
afterEach(() => installed.set([]))

const render = (text: string, origin?: MarkdownOrigin) => {
  const view = renderSolid(() => <Markdown origin={origin} text={text} />)
  flush()
  const links = [...view.querySelectorAll('[data-href], a[href]')].map(
    (link) => link.getAttribute('data-href') ?? link.getAttribute('href')!,
  )
  const images = [...view.querySelectorAll('img')].map((image) => image.getAttribute('src'))
  const local = [
    ...view.querySelectorAll('[data-local-link], [data-local-inline], [data-local-block]'),
  ].map((node) =>
    node.hasAttribute('data-local-link')
      ? `link ${node.getAttribute('data-local-link')}`
      : node.hasAttribute('data-local-inline')
        ? 'inline'
        : 'block',
  )
  return { html: view.innerHTML, links, images, local }
}

const references =
  '#123 #123/456 [preview](http://localhost:1234/) [internal](?conversation=123) [public](https://public.example/path) `#123`\n\n```text\npeer code\n```'

it('keeps local renderers for local Markdown and leaves them out of another instance’s', () => {
  expect(render(references).local).toEqual(
    expect.arrayContaining([
      'link #conversation-123',
      'link #conversation-123-456',
      'inline',
      'block',
    ]),
  )
  for (const url of [undefined, 'https://peer.example/app/', 'https://other.example/project/']) {
    const { html, links, local } = render(references, { url })
    expect(local).toEqual([])
    expect(html).toContain('#123/456')
    expect(html).toContain('peer code')
    expect(links).toContain('https://public.example/path')
    expect(links.some((href) => href.includes('localhost') || /^[?#]/.test(href))).toBe(false)
    expect(links.filter((href) => href === `${url}?conversation=123`)).toHaveLength(url ? 2 : 0)
  }
  expect(render(references, { preview: 'http://localhost:1234/' }).links).toContain(
    'http://localhost:1234/',
  )
})

it('resolves direct and reference images and links against the source and drops raw HTML', () => {
  const media = [
    '![direct](/screenshot.png)',
    '![reference][shot]',
    '![loopback](http://localhost:4747/private.png)',
    '![public](https://images.example/shot.png)',
    '[branch reference][branch] [loopback reference][bad]',
    '',
    '<img src="http://localhost:4747/raw.png">',
    '',
    '[shot]: screenshots/reference.png',
    '[bad]: http://localhost:4747/reference.png',
    '[branch]: ?conversation=321',
  ].join('\n')
  expect(render(media).html).toContain('localhost:4747')
  for (const url of [undefined, 'https://peer.example/app/']) {
    const { html, links, images } = render(media, { url })
    expect(html).not.toContain('localhost:4747')
    expect(images).toEqual(
      url
        ? [
            'https://peer.example/screenshot.png',
            'https://peer.example/app/screenshots/reference.png',
            'https://images.example/shot.png',
          ]
        : ['https://images.example/shot.png'],
    )
    expect(links).toEqual(url ? ['https://peer.example/app/?conversation=321'] : [])
  }
})
