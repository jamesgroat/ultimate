import { createElement as h } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { MarkdownSource, MessageResponse } from '@/components/ai/message'
import type { ExtensionRecord } from '../../../../web/src/sdk/registry.ts'
import type { InboxBoard } from '../../ui.tsx'
import type { Message } from '../../../messages/refs.ts'

const state = vi.hoisted(() => ({
  messages: undefined as Message[] | undefined,
  remote: false,
  source: 'machine/project',
  url: undefined as string | undefined,
  preview: undefined as string | undefined,
  input: undefined as InboxBoard | undefined,
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
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  definePoint: (name: string) => ({ name }),
  defineWebExtension: (value: unknown) => value,
  provide: (point: unknown, use: unknown) => ({ point, use }),
  Provided: ({
    input,
    children,
  }: {
    input: InboxBoard
    children: (board: InboxBoard) => ReactNode
  }) => {
    state.input = input
    return children(
      state.remote
        ? {
            ...input,
            items: input.items.map((item) => ({
              message: item.message,
              source: state.source,
              sourceLabel: 'Peer project',
              sourceHref: state.url,
              preview: state.preview,
              transport: { answer: async () => undefined, dismiss: async () => undefined },
            })),
          }
        : input,
    )
  },
  events: { emit: () => {} },
  formatAgo: () => 'now',
  formatTime: () => 'today',
  Header: ({ children }: { children: ReactNode }) => h('header', null, children),
  Sidebar: () => null,
  useDocOf: () => (state.messages === undefined ? undefined : { messages: state.messages }),
  useEvent: () => {},
  useNow: () => 1000,
  useUltimate: () => ({ showSurface: () => {}, switchConversation: () => {} }),
  useViewport: () => 'desktop',
  useConversation: () => 42,
}))
vi.mock('../../../conversations/ui.tsx', async () => ({
  featureHue: (await import('../../../conversations/feature.tsx')).featureHue,
  FeatureTag: () => null,
  useOverview: () => ({}),
  useStandingName: () => undefined,
}))
vi.mock('../../../messages/ui.tsx', async () => ({
  Body: (await import('../../../messages/cards.tsx')).Body,
  emptyMessages: { messages: [] },
  MessageImages: () => null,
  MessagesDoc: { kind: 'messages' },
  stateTone: { waits: 'text-brand' },
}))
vi.mock('../../../workspaces/ui.tsx', () => ({}))
vi.mock('../../../sidebar/ui.tsx', () => ({ UnderUltimate: {} }))
vi.mock('../../../subagents/ui.tsx', () => ({ talkToUltimate: async () => undefined }))
import extension from '../../web.tsx'
import { featureHue } from '../../../conversations/feature.tsx'

const references =
  '#123 #123/456 [preview](http://localhost:1234/) [internal](?conversation=123) [public](https://public.example/path) `#123`\n\n```text\npeer code\n```'
const message: Message = {
  id: 7,
  from: 42,
  to: 'user',
  at: 100,
  reply: true,
  state: 'delivered',
  text: `**Question**\nBody ${references}`,
  questions: [
    {
      text: 'Keep it?',
      kind: 'choice',
      options: [
        { label: 'Keep', recommended: true, preview: `Option ${references}` },
        { label: 'Drop' },
      ],
    },
  ],
}
const surface = () => renderToStaticMarkup(h(extension.surfaces![0].component))
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1])

beforeEach(() => {
  state.messages = [message]
  state.remote = false
  state.source = 'machine/project'
  state.url = undefined
  state.preview = undefined
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

it('isolates remote body and option-preview references while local Markdown still uses local renderers', () => {
  const local = surface()
  expect(local.match(/data-local-link="#conversation-123"/g)).toHaveLength(2)
  expect(local.match(/data-local-link="#conversation-123-456"/g)).toHaveLength(2)
  expect(local.match(/data-local-link="http:\/\/localhost:1234\/"/g)).toHaveLength(2)
  expect(local.match(/data-local-code/g)).toHaveLength(2)
  expect(local.match(/data-local-block/g)).toHaveLength(2)

  state.remote = true
  for (const url of [undefined, 'https://peer.example/app/', 'https://other.example/project/']) {
    state.url = url
    state.calls = []
    state.links = []
    const remote = surface()
    expect(remote).toContain('Body')
    expect(remote).toContain('Option')
    expect(remote).toContain('#123/456')
    expect(remote).toContain('<code')
    expect(remote).toContain('peer code')
    expect(remote).not.toContain('data-local-')
    expect(remote).not.toContain('[blocked]')
    expect(state.calls).toEqual([])
    expect(remote.match(/<button[^>]*data-streamdown="link"/g)).toHaveLength(url ? 6 : 2)
    expect(hrefs(remote)).not.toContain('https://public.example/path')
    const links = state.links
    expect(links.filter((href) => href === 'https://public.example/path')).toHaveLength(2)
    expect(links.some((href) => href.includes('localhost'))).toBe(false)
    expect(links.some((href) => href.startsWith('?') || href.startsWith('#'))).toBe(false)
    expect(links.filter((href) => url && href === `${url}?conversation=123`)).toHaveLength(
      url ? 4 : 0,
    )
  }
  state.preview = 'http://localhost:1234/'
  state.links = []
  surface()
  expect(state.links.filter((href) => href === state.preview)).toHaveLength(2)
  expect(state.calls).toEqual([])
})

it('scopes direct and reference images and links in the body and option previews, and skips remote raw HTML', () => {
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
  state.messages = [
    {
      ...message,
      text: `**Images**\n${media}`,
      questions: [
        {
          text: 'Keep it?',
          kind: 'choice',
          options: [{ label: 'Keep', recommended: true, preview: media }, { label: 'Drop' }],
        },
      ],
    },
  ]
  const localMedia = surface()
  expect(state.images.filter(({ src }) => src === '/screenshot.png')).toHaveLength(2)
  expect(localMedia).toContain('![reference][shot]')
  expect(state.images.some(({ src }) => src === 'http://localhost:4747/raw.png')).toBe(true)

  state.remote = true
  for (const url of [undefined, 'https://peer.example/app/']) {
    state.url = url
    state.images = []
    state.links = []
    const remote = surface()
    const sources = state.images.map(({ src }) => src)
    expect(sources.filter((src) => src === 'https://images.example/shot.png')).toHaveLength(2)
    expect(sources.filter((src) => src === 'https://peer.example/screenshot.png')).toHaveLength(
      url ? 2 : 0,
    )
    expect(remote).toContain('![reference][shot]')
    expect(sources).toHaveLength(url ? 4 : 2)
    expect(state.images.every(({ srcSet }) => srcSet === undefined)).toBe(true)
    expect(remote).not.toContain('localhost:4747')
    expect(state.links.some((href) => href.startsWith('?') || href.includes('localhost'))).toBe(
      false,
    )

    state.images = []
    state.links = []
    const resolved = renderToStaticMarkup(
      h(MarkdownSource, {
        url,
        children: h(MessageResponse, { mode: 'static', children: media }),
      }),
    )
    const resolvedSources = state.images.map(({ src }) => src)
    expect(resolvedSources.filter((src) => src === 'https://images.example/shot.png')).toHaveLength(
      1,
    )
    expect(
      resolvedSources.filter((src) => src === 'https://peer.example/screenshot.png'),
    ).toHaveLength(url ? 1 : 0)
    expect(
      resolvedSources.filter((src) => src === 'https://peer.example/app/screenshots/reference.png'),
    ).toHaveLength(url ? 1 : 0)
    expect(resolvedSources).toHaveLength(url ? 3 : 1)
    expect(state.images.every(({ srcSet }) => srcSet === undefined)).toBe(true)
    expect(resolved).not.toContain('localhost:4747')
    expect(
      state.links.filter((href) => href === 'https://peer.example/app/?conversation=321'),
    ).toHaveLength(url ? 1 : 0)
    expect(state.links.some((href) => href.startsWith('?') || href.includes('localhost'))).toBe(
      false,
    )
  }
})

it('colours peer chips in the list and reading pane by namespace while leaving local labels unchanged', () => {
  expect(surface()).not.toContain('data-inbox-source')
  state.remote = true
  const remote = surface()
  expect(remote.match(/data-inbox-source="machine\/project"/g)).toHaveLength(2)
  const chips = [...remote.matchAll(/class="([^"]*)" data-inbox-source=/g)]
  expect(chips).toHaveLength(2)
  for (const chip of chips) expect(chip[1]).toContain(featureHue(state.source))
  state.source = 'other/project'
  const other = surface()
  expect(other.match(/data-inbox-source="other\/project"/g)).toHaveLength(2)
  expect(other).toContain(featureHue(state.source))
})

it('passes loading to the source until the local messages document arrives', () => {
  state.remote = true
  state.messages = undefined
  expect(surface()).not.toContain('Every branch has what it needs.')
  expect(state.input?.status.state).toBe('loading')
  state.messages = []
  expect(surface()).toContain('Every branch has what it needs.')
  expect(state.input?.status.state).toBe('complete')
})
