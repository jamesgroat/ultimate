import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../server/extensions.ts'
import { cloudConfig } from '../lib/cloud.ts'
import { writeJson } from '../lib/json-file.ts'
import { machineName } from '../lib/machine.ts'
import { join as joinCloud } from '../extensions/cloud/join.ts'
import type { JoinDeps } from '../extensions/cloud/join.ts'
import { locate, selfAddress } from '../lib/remote.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import { temp } from './helpers.ts'

const os = vi.hoisted(() => ({ hostname: 'desktop.example.com' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  hostname: () => os.hostname,
  platform: () => 'darwin',
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: () => ({ status: 0, stdout: 'desktop-4\n' }),
}))
vi.mock('../lib/exec.ts', () => ({
  exec: async (command: string, args: string[]) => {
    if (command === 'scutil' && args.join(' ') === '--get LocalHostName')
      return { stdout: 'desktop-4\n', stderr: '' }
    throw new Error(`unexpected ${command}`)
  },
}))

beforeEach(() => {
  os.hostname = 'desktop.example.com'
  vi.unstubAllEnvs()
  vi.stubEnv('ULTIMATE_MACHINE', undefined)
  vi.stubEnv('ULTIMATE_CLOUD_MACHINE', undefined)
})

async function fixture(settings: JsonObject) {
  const userHome = await temp()
  await writeJson(join(userHome, '.ultimate/settings.json'), settings)
  return {
    userHome,
    notice: () => {},
    projects: async () => [
      { name: 'my-app', current: true },
      { name: 'docs', current: false, running: { url: 'http://127.0.0.1:4748' } },
    ],
  } as unknown as ExtensionHost
}

it('keeps the configured identity after an OS hostname change, without cloud', async () => {
  const host = await fixture({ machine: 'desktop.example.com' })
  os.hostname = 'desktop-4.local'
  expect(await selfAddress(host)).toEqual({ project: 'my-app', machine: 'desktop.example.com' })
  expect(await locate(host, 'my-app', 'desktop.example.com')).toEqual({ current: true })
  expect(await locate(host, 'docs', 'desktop.example.com')).toMatchObject({
    url: 'http://127.0.0.1:4748',
  })
})

it('prefers environment, then machine setting, then cloud.machine, then stable hostname', async () => {
  const host = await fixture({ machine: 'set', cloud: { machine: 'cloud' } })
  expect(
    await machineName(host.userHome, { ULTIMATE_MACHINE: 'env', ULTIMATE_CLOUD_MACHINE: 'old' }),
  ).toBe('env')
  expect(await machineName(host.userHome, { ULTIMATE_CLOUD_MACHINE: 'old' })).toBe('old')
  expect(await machineName(host.userHome, {})).toBe('set')
  expect(await machineName((await fixture({ cloud: { machine: 'cloud' } })).userHome, {})).toBe(
    'cloud',
  )
  expect(await machineName((await fixture({})).userHome, {})).toBe('desktop-4')
})

it('prefers explicit remotes even over the canonical local identity, but unqualified reads stay local', async () => {
  const host = await fixture({
    machine: 'desktop.example.com',
    remotes: {
      'desktop.example.com': {
        docs: 'https://remote.example/docs',
        'my-app': 'https://remote.example/app',
      },
      desktop: { docs: 'https://alias.example/docs' },
    },
  })
  expect(await locate(host, 'my-app')).toEqual({ current: true })
  expect(await locate(host, 'docs')).toMatchObject({ url: 'http://127.0.0.1:4748' })
  expect(await locate(host, 'my-app', 'desktop.example.com')).toMatchObject({
    url: 'https://remote.example/app',
  })
  expect(await locate(host, 'docs', 'DESKTOP.EXAMPLE.COM')).toMatchObject({
    url: 'https://remote.example/docs',
  })
  expect(await locate(host, 'docs', 'desktop')).toMatchObject({
    url: 'https://alias.example/docs',
  })
})

it('gives cloud the same identity that messages advertise', async () => {
  const host = await fixture({ machine: 'desk', cloud: { url: 'wss://user/sync' } })
  await writeSecret(host.userHome, 'ULTIMATE_CLOUD_TOKEN', 'secret-token')
  expect((await cloudConfig(host, {}))?.machine).toBe('desk')
  expect((await selfAddress(host)).machine).toBe('desk')
})

it('refuses cloud join under a name different from the pinned identity', async () => {
  const deps = {
    fetch: async () => Response.json({ projects: [] }),
    setSecret: vi.fn<JoinDeps['setSecret']>(async () => undefined),
    saveCloud: vi.fn<JoinDeps['saveCloud']>(async () => undefined),
    pinnedMachine: 'desk',
  }
  const input = { url: 'wss://cloud.example', token: 't', snapshotKey: 'k' }
  expect(await joinCloud(deps, { ...input, machine: 'backup-desk' })).toMatchObject({
    ok: false,
    error: expect.stringContaining('join as desk'),
  })
  expect(deps.saveCloud).not.toHaveBeenCalled()
  expect(await joinCloud(deps, { ...input, machine: 'desk' })).toMatchObject({
    ok: true,
    machine: 'desk',
  })
})
