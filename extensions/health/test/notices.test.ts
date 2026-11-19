import { afterEach, expect, it } from 'vitest'
import { classifyFailure } from '../failure.ts'
import { notifier } from '../server.ts'
import { noticeFor } from '../notice.ts'
import { removeTemps, temp, until } from '../../../test/helpers.ts'

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
    ['Your plan has no usage credits left', 402, 'billing'],
    [
      '429 Rate limit reached for gpt-6 on tokens per min (TPM). Please try again in 2s.',
      undefined,
      'other',
    ],
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

async function setup(home?: string) {
  home ??= await temp()
  let now = NOW
  const posted: { key: string; slot: string; title: string; text: string }[] = []
  const inbox = new Map<string, { key: string; title: string }>()
  const keys = new Set<string>()
  const delivery = { down: false }
  const queue = {
    writes: Promise.resolve() as Promise<unknown>,
    delivering: new Map<string, Promise<void>>(),
  }
  const gate = { wait: undefined as Promise<void> | undefined }
  const make = () =>
    notifier({
      home,
      queue,
      now: () => now,
      post: async (notice) => {
        await gate.wait
        if (delivery.down) throw new Error('notices unavailable')
        posted.push(notice)
        if (keys.has(notice.key)) return true
        keys.add(notice.key)
        inbox.set(notice.slot, notice)
        return true
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
  return {
    home,
    queue,
    gate,
    health: make(),
    make,
    delivery,
    posted,
    inbox,
    tick: (ms: number) => (now += ms),
  }
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

it('subscription routing exhaustion posts once with its reset, and shares the episode with model errors', async () => {
  const t = await setup()
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

it('an episode per class: billing, auth, billing again without a success posts two notices, not three', async () => {
  const t = await setup()
  await t.health.report(credits)
  await t.health.report({ provider: 'typesafe', ok: false, status: 401, error: 'invalid key' })
  await t.health.report(credits)
  expect(t.posted.map((notice) => notice.key.split(':')[2])).toEqual(['billing', 'auth'])
})

it('a notice that could not be delivered is retried with its original key on the next failure', async () => {
  const t = await setup()
  t.delivery.down = true
  await t.health.report(credits)
  t.delivery.down = false
  t.tick(5000)
  await t.health.report(credits)
  await t.health.report(credits)
  expect(t.posted).toHaveLength(1)
  expect(t.posted[0].key).toBe(`health:typesafe:billing:${NOW}`)
})

it('notifiers sharing a queue, as across a facet reload, open one episode for concurrent failures', async () => {
  const t = await setup()
  const replacement = t.make()
  await Promise.all([
    t.health.report(credits),
    replacement.report(credits),
    t.health.report(credits),
  ])
  expect(t.posted).toHaveLength(1)
})

it('a routing exhaustion whose notice failed is delivered by a later reading once notices recover', async () => {
  const t = await setup()
  t.delivery.down = true
  await t.health.routing(plan(true))
  t.delivery.down = false
  await t.health.routing(plan(true))
  await t.health.routing(plan(true))
  expect(t.posted).toHaveLength(1)
})

it('release drains a delivery in flight, and a delivery cut off by a restart is retried by a fresh notifier', async () => {
  const t = await setup()
  const hold = Promise.withResolvers<void>()
  t.gate.wait = hold.promise
  const reporting = t.health.report(credits)
  await until(() => t.queue.delivering.size === 1)
  hold.resolve()
  await Promise.all(t.queue.delivering.values())
  await reporting
  expect(t.posted).toHaveLength(1)

  const crashed = await setup()
  crashed.gate.wait = new Promise(() => {})
  const cutOff = crashed.health.report(credits)
  await until(() => crashed.queue.delivering.size === 1)
  const restarted = await setup(crashed.home)
  await restarted.health.report(credits)
  expect(restarted.posted.map((notice) => notice.key)).toEqual([`health:typesafe:billing:${NOW}`])
  expect(await Promise.race([cutOff.then(() => 'settled'), Promise.resolve('pending')])).toBe(
    'pending',
  )
})

it('drain waits for a report still blocked on its opening write, and admits nothing after it starts', async () => {
  const t = await setup()
  const blocked = Promise.withResolvers<void>()
  t.queue.writes = blocked.promise
  const reporting = t.health.report(credits)
  let drained = false
  const draining = t.health.drain().then(() => (drained = true))
  await t.health.report({ ...credits, status: 401, error: 'invalid key' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(drained).toBe(false)
  blocked.resolve()
  await draining
  await reporting
  expect(t.posted.map((notice) => notice.key)).toEqual([`health:typesafe:billing:${NOW}`])
})
