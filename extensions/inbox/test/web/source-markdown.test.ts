import { createElement as h } from 'react'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { MarkdownSource, MessageResponse } from '@/components/ai/message'
import { MessageQuestions } from '../../../questions/ui.tsx'
import type { ExtensionRecord } from '../../../../web/src/sdk/registry.ts'

const state = vi.hoisted(() => ({
  calls: [] as string[],
  links: [] as string[],
  images: [] as { src: unknown; srcSet: unknown }[],
  records: [] as ExtensionRecord[],
}))
vi.mock('streamdown', async (original) => {
  const streamdown = await original<typeof import('streamdown')>()
  return {
    ...streamdown,
    defaultComponents: {
      ...streamdown.defaultComponents,
      a: (props: ComponentProps<typeof streamdown.defaultComponents.a>) => {
        if (props.href) state.links.push(props.href)
        return h(streamdown.defaultComponents.a, props)
      },
      img: (props: ComponentProps<typeof streamdown.defaultComponents.img>) => {
        state.images.push({ src: props.src, srcSet: props.srcSet })
        return h(streamdown.defaultComponents.img, props)
      },
    },
  }
})
vi.mock('../../../../web/src/sdk/hooks.ts', async () => ({
  ExtensionNameContext: (await import('react')).createContext<string | undefined>(undefined),
  useExtensions: () => state.records,
  useSystem: () => undefined,
}))
vi.mock('@/sdk', () => ({
  api: { action: () => {} },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  useViewport: () => 'desktop',
  useDocOf: () => undefined,
  useConversation: () => 42,
  useUiState: (_key: string, initial: unknown) => [initial, () => {}],
}))
vi.mock('../../../messages/ui.tsx', () => ({ MessagesDoc: { kind: 'messages' } }))

const references =
  '#123 #123/456 [preview](http://localhost:1234/) [internal](?conversation=123) [public](https://public.example/path) `#123`\n\n```text\npeer code\n```'
const content = (text: string) => [
  h(MessageResponse, { key: 'body', children: `Body ${text}` }),
  h(MessageQuestions, {
    key: 'card',
    message: {
      id: 7,
      from: 42,
      to: 'user',
      reply: true,
      state: 'delivered',
      questions: [
        {
          text: 'Keep it?',
          kind: 'choice',
          options: [
            { label: 'Keep', recommended: true, preview: `Option ${text}` },
            { label: 'Drop' },
          ],
        },
      ],
    },
  }),
]
const remote = (text: string, url?: string, preview?: string) =>
  renderToStaticMarkup(h(MarkdownSource, { url, preview, children: content(text) }))

beforeEach(() => {
  state.calls = []
  state.links = []
  state.images = []
  state.records = [
    {
      name: 'local',
      version: 1,
      loading: false,
      extension: {
        link: ({ href, children }) => {
          state.calls.push(href)
          return h('span', { 'data-local-link': href }, children)
        },
        inlineCode: ({ code }) => {
          state.calls.push('inline')
          return h('code', { 'data-local-code': true }, code)
        },
        codeBlocks: {
          text: ({ code }) => {
            state.calls.push('block')
            return h('pre', { 'data-local-block': true }, code)
          },
        },
      },
    },
  ]
})

it('isolates remote body and option-preview references while local Markdown keeps local renderers', () => {
  const local = renderToStaticMarkup(content(references))
  expect(local.match(/data-local-link="#conversation-123"/g)).toHaveLength(2)
  expect(local.match(/data-local-link="#conversation-123-456"/g)).toHaveLength(2)
  expect(local.match(/data-local-code/g)).toHaveLength(2)
  expect(local.match(/data-local-block/g)).toHaveLength(2)
  for (const url of [undefined, 'https://peer.example/app/', 'https://other.example/project/']) {
    state.calls = []
    state.links = []
    const html = remote(references, url)
    expect(html).toContain('Body')
    expect(html).toContain('Option')
    expect(html).toContain('#123/456')
    expect(html).toContain('peer code')
    expect(html).not.toContain('data-local-')
    expect(state.calls).toEqual([])
    expect(state.links.filter((href) => href === 'https://public.example/path')).toHaveLength(2)
    expect(
      state.links.some(
        (href) => href.includes('localhost') || href.startsWith('?') || href.startsWith('#'),
      ),
    ).toBe(false)
    expect(state.links.filter((href) => url && href === `${url}?conversation=123`)).toHaveLength(
      url ? 4 : 0,
    )
  }
  state.links = []
  remote(references, undefined, 'http://localhost:1234/')
  expect(state.links.filter((href) => href === 'http://localhost:1234/')).toHaveLength(2)
})

it('scopes direct/reference images and links and strips remote raw HTML before rehypeRaw', () => {
  const media = [
    '![direct](/screenshot.png)',
    '![reference][shot]',
    '![loopback](http://localhost:4747/private.png)',
    '![loopback reference][bad]',
    '![public](https://images.example/shot.png)',
    '[branch reference][branch] [loopback reference][bad]',
    '',
    '<img src="http://localhost:4747/raw.png" srcset="http://localhost:4747/raw2.png 2x">',
    '<img src="/raw-relative.png">',
    '',
    '[shot]: screenshots/reference.png',
    '[bad]: http://localhost:4747/reference.png',
    '[branch]: ?conversation=321',
  ].join('\n')
  const local = renderToStaticMarkup(content(media))
  expect(state.images.filter(({ src }) => src === '/screenshot.png')).toHaveLength(2)
  expect(local).toContain('![reference][shot]')
  expect(state.images.some(({ src }) => src === 'http://localhost:4747/raw.png')).toBe(true)
  for (const url of [undefined, 'https://peer.example/app/']) {
    state.images = []
    state.links = []
    const html = remote(media, url)
    expect(
      state.images.filter(({ src }) => src === 'https://images.example/shot.png'),
    ).toHaveLength(2)
    expect(
      state.images.filter(({ src }) => src === 'https://peer.example/screenshot.png'),
    ).toHaveLength(url ? 2 : 0)
    expect(state.images).toHaveLength(url ? 4 : 2)
    expect(state.images.every(({ srcSet }) => srcSet === undefined)).toBe(true)
    expect(html).not.toContain('localhost:4747')
    state.images = []
    state.links = []
    const resolved = renderToStaticMarkup(
      h(MarkdownSource, { url, children: h(MessageResponse, { mode: 'static', children: media }) }),
    )
    expect(
      state.images.filter(
        ({ src }) => src === 'https://peer.example/app/screenshots/reference.png',
      ),
    ).toHaveLength(url ? 1 : 0)
    expect(state.images).toHaveLength(url ? 3 : 1)
    expect(resolved).not.toContain('localhost:4747')
    expect(
      state.links.filter((href) => href === 'https://peer.example/app/?conversation=321'),
    ).toHaveLength(url ? 1 : 0)
    expect(state.links.some((href) => href.startsWith('?') || href.includes('localhost'))).toBe(
      false,
    )
  }
})
