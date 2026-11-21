import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
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

const os = vi.hoisted(() => ({ hostname: 'nevyn.malazan.groat.com' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  hostname: () => os.hostname,
}))
vi.mock('../lib/exec.ts', () => ({
  exec: async (command: string, args: string[]) => {
    if (command === 'scutil' && args.join(' ') === '--get LocalHostName')
      return { stdout: 'nevyn-4\n', stderr: '' }
    throw new Error(`unexpected ${command}`)
  },
}))

const platform = process.platform
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }))
afterAll(() => Object.defineProperty(process, 'platform', { value: platform }))
beforeEach(() => {
  os.hostname = 'nevyn.malazan.groat.com'
  vi.unstubAllEnvs()
  vi.stubEnv('ULTIMATE_MACHINE', undefined)
  vi.stubEnv('ULTIMATE_CLOUD_MACHINE', undefined)
})

async function fixture(settings: JsonObject) {
  const userHome = await temp()
  await writeJson(join(userHome, '.ultimate/settings.json'), settings)
  const host = {
    userHome,
    notice: () => {},
    projects: async () => [
      { name: 'life', current: true },
      { name: 'onasset', current: false, running: { url: 'http://127.0.0.1:4748' } },
    ],
  } as unknown as ExtensionHost
  return host
}

it('keeps the configured machine name when the OS hostname changes, with no cloud', async () => {
  // Moving to launchd changed the hostname from nevyn-4.local and every peer's route back broke.
  const host = await fixture({ machine: 'nevyn.malazan.groat.com' })
  os.hostname = 'nevyn-4.local'
  expect(await selfAddress(host)).toEqual({ project: 'life', machine: 'nevyn.malazan.groat.com' })
  expect(await locate(host, 'life', 'nevyn.malazan.groat.com')).toEqual({ current: true })
  expect(await locate(host, 'onasset', 'nevyn.malazan.groat.com')).toMatchObject({
    url: 'http://127.0.0.1:4748',
  })
})

it('resolves the environment, then the machine setting, then cloud.machine, then the hostname', async () => {
  const host = await fixture({ machine: 'set', cloud: { machine: 'cloud' } })
  expect(
    await machineName(host.userHome, { ULTIMATE_MACHINE: 'env', ULTIMATE_CLOUD_MACHINE: 'old' }),
  ).toBe('env')
  expect(await machineName(host.userHome, { ULTIMATE_CLOUD_MACHINE: 'old' })).toBe('old')
  expect(await machineName(host.userHome, {})).toBe('set')
  expect(await machineName((await fixture({ cloud: { machine: 'cloud' } })).userHome, {})).toBe(
    'cloud',
  )
  expect(await machineName((await fixture({})).userHome, {})).toBe('nevyn.malazan.groat.com')
})

it("resolves this host's other names locally and still refuses another machine", async () => {
  const host = await fixture({ machine: 'nevyn.malazan.groat.com' })
  for (const alias of ['nevyn-4.local', 'nevyn-4', 'NEVYN', 'nevyn.malazan.groat.com'])
    expect(await locate(host, 'onasset', alias)).toMatchObject({ url: 'http://127.0.0.1:4748' })
  await expect(locate(host, 'onasset', 'vault')).rejects.toThrow('Unknown project onasset on vault')
  await expect(locate(host, 'onasset', 'nevyn-5.local')).rejects.toThrow(
    'Unknown project onasset on nevyn-5.local',
  )
})

it('routes to a remote the user keyed on a name that is also an alias of this host', async () => {
  const host = await fixture({
    machine: 'nevyn.malazan.groat.com',
    remotes: {
      nevyn: { onasset: 'https://nevyn.tail.ts.net:4748', blog: 'https://nevyn.tail.ts.net:4749' },
    },
  })
  expect(await locate(host, 'onasset', 'nevyn')).toMatchObject({
    url: 'https://nevyn.tail.ts.net:4748',
  })
  expect(await locate(host, 'blog', 'nevyn')).toMatchObject({
    url: 'https://nevyn.tail.ts.net:4749',
  })
  expect(await locate(host, 'onasset', 'nevyn-4.local')).toMatchObject({
    url: 'http://127.0.0.1:4748',
  })
})

it('gives the cloud register the same machine name that messages advertise', async () => {
  const host = await fixture({ machine: 'desk', cloud: { url: 'wss://user/sync' } })
  await writeSecret(host.userHome, 'ULTIMATE_CLOUD_TOKEN', 'secret-token')
  expect((await cloudConfig(host, {}))?.machine).toBe('desk')
  expect((await selfAddress(host)).machine).toBe('desk')
})

it('refuses a cloud join under another name than the pinned one', async () => {
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
