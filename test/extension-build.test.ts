import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { until } from './helpers.ts'
import { fixture } from './server-fixture.ts'

it('keeps the build unchanged until a discovered enablement change is installed', async () => {
  const { server, options } = await fixture(false, {
    trigger: "export default { name: 'trigger' }",
    target: "export default { name: 'target' }",
  })
  const settings = join(options.projectRoot, '.ultimate/settings.json')
  const added = server.vite.watcher.listeners('add')
  const changed = server.vite.watcher.listeners('change')
  await server.vite.watcher.close()
  const initial = server.host.build()
  const value = JSON.parse(await readFile(settings, 'utf8'))
  value.extensions.enable = value.extensions.enable.filter((name: string) => name !== 'target')
  value.extensions.disable = ['target']
  await writeFile(settings, JSON.stringify(value))
  const refresh = vi.spyOn(server.host.builds, 'refresh')
  for (const listener of added) listener(join(options.ultimateRoot, 'extensions/trigger/README.md'))
  await until(() => refresh.mock.calls.length > 0)
  expect(server.extensions.info().find((entry) => entry.name === 'target')?.enabled).toBe(true)
  expect(server.host.build().extensions.target).toBe(initial.extensions.target)
  expect(server.host.build().id).toBe(initial.id)
  for (const listener of changed) listener(settings)
  await until(() => !server.host.build().extensions.target)
  expect(server.extensions.info().find((entry) => entry.name === 'target')?.enabled).toBe(false)
  expect(server.host.build().id).not.toBe(initial.id)
})
