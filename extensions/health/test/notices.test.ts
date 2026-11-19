import { afterEach, expect, it } from 'vitest'
import { classifyFailure } from '../failure.ts'
import { notifier } from '../server.ts'
import { noticeFor } from '../notice.ts'
import { removeTemps, temp } from '../../../test/helpers.ts'

afterEach(removeTemps)

const NOW = Date.parse('2026-11-18T20:00:00Z')

it('classifies real provider errors as billing, usage, auth or other', () => {
  const cases: [string, number | undefined, string][] = [
    [
      '{"detail":{"error_type":"billing_error","message":"Your organization has no available TypeSafe API credits"}}',
      402,
      'billing',
    ],
    ['TypeSafe 402: no available TypeSafe API credits', undefined, 'billing'],
    ['402 Payment Required', undefined, 'billing'],
    ['OpenRouter: insufficient funds', undefined, 'billing'],
    [
      'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.',
      undefined,
      'usage',
    ],
    ['429 {"error":{"type":"usage_limit_reached","resets_at":1795100000}}', undefined, 'usage'],
    ['429 insufficient_quota: You exceeded your current quota', undefined, 'usage'],
    ['Claude AI usage limit reached|1795100000', undefined, 'usage'],
    [
      'Claude Code billing: Anthropic did not accept this request on your Claude plan limits and wants to charge it to usage credits.',
      undefined,
      'usage',
    ],
    [
      'Claude Code is installed but not logged in. Run `claude auth login` and try again.',
      undefined,
      'auth',
    ],
    [
      'OAuth refresh failed for anthropic: Anthropic token refresh request failed. status=400 {"error":"invalid_grant"}',
      undefined,
      'auth',
    ],
    ['TypeSafe 401: invalid key', 401, 'auth'],
    [
      'Codex error: Our servers are currently overloaded. Please try again later.',
      undefined,
      'other',
    ],
    [
      "Incomplete Claude Code upstream response (status 429, capture incomplete, upstream said: This request would exceed your account's rate limit. Please try again later.)",
      undefined,
      'other',
    ],
    ['WebSocket closed 1012', undefined, 'other'],
    ['context_length_exceeded: Claude Code request failed: Prompt is too long', undefined, 'other'],
  ]
  for (const [error, status, expected] of cases)
    expect([error, classifyFailure({ status, error }, NOW).class]).toEqual([error, expected])
  expect(
    classifyFailure({ error: 'You have hit your ChatGPT usage limit. Try again in ~42 min.' }, NOW)
      .resetsAt,
  ).toBe(NOW + 42 * 60_000)
  expect(
    classifyFailure({ error: '429 {"resets_at":1795100000} usage_limit_reached' }, NOW).resetsAt,
  ).toBe(1795100000_000)
})

async function setup() {
  const home = await temp()
  let now = NOW
  const posted: { key: string; slot: string; title: string; text: string }[] = []
  const inbox = new Map<string, { key: string; title: string }>()
  const keys = new Set<string>()
  const health = notifier({
    home,
    now: () => now,
    post: async (notice) => {
      posted.push(notice)
      if (keys.has(notice.key)) return
      keys.add(notice.key)
      inbox.set(notice.slot, notice)
    },
    describe: async (provider, cls, resetsAt) =>
      noticeFor({
        provider,
        name: provider === 'typesafe' ? 'TypeSafe' : 'Claude Code',
        class: cls,
        resetsAt,
        agents: ['coordinator'],
        timeZone: 'America/Phoenix',
      }),
  })
  return { health, posted, inbox, tick: (ms: number) => (now += ms) }
}

const credits = {
  provider: 'typesafe',
  ok: false,
  status: 402,
  error: 'no available TypeSafe API credits',
}

it('500 consecutive 402s post one notice; a success re-arms, and the next episode replaces it in its slot', async () => {
  const t = await setup()
  for (let i = 0; i < 500; i++) {
    t.tick(1000)
    await t.health.report(credits)
  }
  expect(t.posted).toHaveLength(1)
  expect(t.posted[0]).toMatchObject({ slot: 'health:typesafe', title: 'TypeSafe: out of credits' })
  expect(t.posted[0].key).toMatch(/^health:typesafe:billing:\d+$/)
  expect(t.posted[0].text).toContain('https://console.typesafe.ai')
  await t.health.report({ provider: 'typesafe', ok: true })
  await t.health.report(credits)
  expect(t.posted).toHaveLength(2)
  expect(t.posted[1].key).not.toBe(t.posted[0].key)
  expect([...t.inbox.values()]).toHaveLength(1)
})

it('a flapping provider keeps one Inbox item: every episode goes to the same slot', async () => {
  const t = await setup()
  for (let i = 0; i < 10; i++) {
    t.tick(60_000)
    await t.health.report(credits)
    await t.health.report({ provider: 'typesafe', ok: true })
  }
  expect(new Set(t.posted.map((notice) => notice.slot))).toEqual(new Set(['health:typesafe']))
  expect(t.inbox.size).toBe(1)
})

it('transient and other failures never post', async () => {
  const t = await setup()
  for (const error of [
    'Codex error: Our servers are currently overloaded.',
    '529 overloaded_error',
    'fetch failed: ETIMEDOUT',
    '500 server_error',
  ])
    await t.health.report({ provider: 'openai-codex', ok: false, error })
  expect(t.posted).toEqual([])
})

it('subscription routing exhaustion posts once with its reset, and shares the episode with model errors', async () => {
  const t = await setup()
  const resetsAt = Date.parse('2026-11-18T22:40:00Z')
  const plan = (exhausted: boolean, paced = true) => ({
    plan: {
      pairs: {
        general: {
          preferred: { provider: 'claude-code', modelId: 'claude-opus-5-5' },
          alternative: { provider: 'openai-codex', modelId: 'gpt-6-astra' },
          readings: {
            preferred: { exhausted, paced, resetsAt },
            alternative: { exhausted: false, paced, resetsAt: null },
          },
        },
      },
    },
  })
  await t.health.routing(plan(false))
  expect(t.posted).toEqual([])
  await t.health.routing(plan(true))
  await t.health.routing(plan(true))
  await t.health.report({
    provider: 'claude-code',
    ok: false,
    error: 'Claude AI usage limit reached',
  })
  expect(t.posted).toHaveLength(1)
  expect(t.posted[0]).toMatchObject({
    slot: 'health:claude-code',
    title: 'Claude Code: usage limit reached (resets 3:40 PM)',
  })
  expect(t.posted[0].text).toContain('the coordinator agent')
})
