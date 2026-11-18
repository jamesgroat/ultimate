import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ModelsResponse } from '../../../../shared/protocol.ts'
import type { FamiliesView } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  query: '',
  models: { models: [], providers: [] } as ModelsResponse,
  families: undefined as FamiliesView | undefined,
  family: null as string | null,
  selections: new Map<string, () => void>(),
  action: vi.fn<(...args: unknown[]) => Promise<null>>(async () => null),
  pass: ({ children }: { children?: ReactNode }) => children ?? null,
}))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) => react.useState(initial === '' ? harness.query : initial),
  }
})
vi.mock('@/sdk', () => ({
  api: { action: harness.action },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  errorMessage: (error: unknown) => String(error),
  useDialog: () => [true, () => {}],
  useUltimate: () => ({}),
}))
vi.mock('../../state.tsx', async (original) => ({
  ...(await original<typeof import('../../state.tsx')>()),
  usePickerTarget: () => undefined,
  useCurrentModel: () => ({
    id: 42,
    ref: { provider: 'anthropic', modelId: 'claude-opus-5-5' },
    thinking: 'high',
    family: harness.family,
    models: harness.models,
    loading: false,
  }),
}))
vi.mock('../../families.tsx', async (original) => ({
  ...(await original<typeof import('../../families.tsx')>()),
  useFamilies: () => harness.families,
}))
// Render the portal in place; expose group order and the controlled highlight, not cmdk's retired defaultValue.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: harness.pass,
  DialogContent: harness.pass,
  DialogDescription: harness.pass,
  DialogTitle: harness.pass,
}))
vi.mock('@/components/ui/command', () => ({
  Command: ({ children, value }: { children: ReactNode; value?: string }) =>
    h('div', { 'data-current': value }, children),
  CommandEmpty: () => null,
  CommandInput: () => null,
  CommandList: harness.pass,
  CommandGroup: ({ heading, children }: { heading: ReactNode; children: ReactNode }) =>
    h('section', null, h('h2', null, heading), children),
  CommandItem: ({
    value,
    children,
    onSelect,
  }: {
    value: string
    children: ReactNode
    onSelect: () => void
  }) => {
    harness.selections.set(value, onSelect)
    return h('div', { 'data-model': value }, children)
  },
}))

import { ModelPicker } from '../../picker.tsx'
import { SelectAction } from '../../refs.ts'

beforeEach(() => {
  harness.query = 'claude-opus'
  harness.family = null
  harness.families = undefined
  harness.selections.clear()
  harness.action.mockClear()
  harness.models = {
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic (Claude Pro/Max)',
        authTypes: [],
        isUsingSubscription: true,
        billing: 'subscription',
        status: { configured: true, source: 'stored' },
      },
      {
        id: 'claude-code',
        name: 'Claude Code',
        authTypes: [],
        isUsingSubscription: true,
        billing: 'subscription',
        status: { configured: true, source: 'stored' },
      },
    ],
    models: [
      ['anthropic', 'claude-opus-4-8'],
      ['anthropic', 'claude-opus-5-5'],
      ['claude-code', 'claude-opus-5-5'],
    ].map(([provider, id]) => ({
      provider,
      id,
      name: id,
      available: true,
      contextWindow: 200_000,
      maxTokens: 32_000,
      reasoning: true,
      thinkingLevels: ['off', 'high'],
      cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
    })),
  }
})

it.each([true, false])(
  'puts the Claude Code group before paid twins (available: %s), preserving the current model highlight',
  (available) => {
    harness.models.models.find((model) => model.provider === 'claude-code')!.available = available
    const html = renderToStaticMarkup(h(ModelPicker))
    expect(html.indexOf('data-model="claude-code/claude-opus-5-5"')).toBeGreaterThan(-1)
    expect(html.indexOf('data-model="claude-code/claude-opus-5-5"')).toBeLessThan(
      html.indexOf('data-model="anthropic/claude-opus-5-5"'),
    )
    expect(html).toContain('data-current="anthropic/claude-opus-5-5"')
  },
)

it.each([
  ['subscription', 'Subscription'],
  ['paid-api', 'Paid API'],
  ['unknown', 'Unknown'],
] as const)(
  'labels Anthropic by its resolved billing (%s), not its provider name',
  (billing, label) => {
    harness.models.providers[0].billing = billing
    harness.models.providers[0].isUsingSubscription = billing === 'subscription'
    const html = renderToStaticMarkup(h(ModelPicker))
    const headings = [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(([, heading]) =>
      heading.replace(/<[^>]+>/g, ''),
    )
    expect(headings).toContain(`anthropicAnthropic (Claude Pro/Max)✓ stored · ${label}`)
    expect(headings).toContain('claude-codeClaude Code✓ stored · Subscription')
    expect(html.includes('Paid API')).toBe(billing === 'paid-api')
  },
)

it('highlights the recorded family among families sharing a model and selects it with one atomic intent action', () => {
  harness.query = ''
  harness.family = 'review'
  harness.families = {
    families: ['default', 'design', 'review'].map((name) => ({
      name,
      color: 'violet',
      builtin: true,
      model: 'anthropic/claude-opus-5-5',
      thinking: 'high',
    })),
    users: [],
    assign: {},
    from: 'builtin',
    errors: [],
  }
  const html = renderToStaticMarkup(h(ModelPicker))
  expect(html).toContain('data-current="family/review"')
  harness.selections.get('family/review')!()
  expect(harness.action).toHaveBeenCalledTimes(1)
  expect(harness.action).toHaveBeenCalledWith(
    SelectAction,
    {
      model: { provider: 'anthropic', modelId: 'claude-opus-5-5' },
      thinkingLevel: 'high',
      family: 'review',
    },
    { conversationId: 42 },
  )
})

it('picking the current model still records manual intent on the scoped conversation and clears its family', () => {
  renderToStaticMarkup(h(ModelPicker))
  harness.selections.get('anthropic/claude-opus-5-5')!()
  expect(harness.action).toHaveBeenCalledTimes(1)
  expect(harness.action).toHaveBeenCalledWith(
    SelectAction,
    {
      model: { provider: 'anthropic', modelId: 'claude-opus-5-5' },
    },
    { conversationId: 42 },
  )
})
