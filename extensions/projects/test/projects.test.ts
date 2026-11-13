import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeJson } from '../../../lib/json-file.ts'
import { temp } from '../../../test/helpers.ts'
import { href } from '../link.ts'
import { list } from '../server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

/** An instance answering `status` with these counts and `tailscale/status` with `tailscale`, if given. */
async function instance(tailscale?: object) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/extensions/status/actions/status') {
      response.end(JSON.stringify({ result: { busy: 2, questions: { count: 1 } } }))
      return
    }
    if (request.url === '/api/extensions/tailscale/actions/status' && tailscale) {
      response.end(JSON.stringify({ result: tailscale }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: `no route ${request.url}` }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

it('lists this machine’s projects with their counts and advertised tailnet URLs, then the other machines’ in remotes', async () => {
  const other = await instance({ state: 'ready', url: 'https://box.tail.ts.net:4749', allow: [] })
  const plain = await instance()
  const laptop = await instance()
  const userHome = await temp()
  await writeJson(join(userHome, '.ultimate/settings.json'), {
    // The laptop's URL ends in a slash, as a user may write it.
    remotes: { laptop: { blog: `${laptop.url}/` }, desktop: { blog: 'http://127.0.0.1:1' } },
  })
  const host = {
    userHome,
    projects: async () => [
      { name: 'down', current: false, running: { pid: 1, url: 'http://127.0.0.1:1' } },
      { name: 'stopped', current: false },
      { name: 'here', current: true },
      { name: 'other', current: false, running: { pid: 3, url: other.url } },
      { name: 'plain', current: false, running: { pid: 4, url: plain.url } },
    ],
    system: () => ({ process: { url: 'http://127.0.0.1:4747' } }),
    conversations: () => [{ busy: true }, { busy: false }],
    need: () => ({ openQuestions: async () => [{}, {}, {}] }),
    want: () => ({
      status: () => ({ state: 'ready', url: 'https://box.tail.ts.net:4747', allow: [] }),
    }),
  } as unknown as ExtensionHost
  try {
    expect(await list(host, new AbortController().signal)).toEqual([
      { name: 'down', url: 'http://127.0.0.1:1', current: false, available: false },
      {
        name: 'here',
        url: 'http://127.0.0.1:4747',
        tailnet: 'https://box.tail.ts.net:4747',
        current: true,
        available: true,
        busy: 1,
        questions: 3,
      },
      {
        name: 'other',
        url: other.url,
        tailnet: 'https://box.tail.ts.net:4749',
        current: false,
        available: true,
        busy: 2,
        questions: 1,
      },
      { name: 'plain', url: plain.url, current: false, available: true, busy: 2, questions: 1 },
      {
        name: 'blog',
        machine: 'laptop',
        url: `${laptop.url}/`,
        current: false,
        available: true,
        busy: 2,
        questions: 1,
      },
      {
        name: 'blog',
        machine: 'desktop',
        url: 'http://127.0.0.1:1',
        current: false,
        available: false,
      },
    ])
  } finally {
    for (const { server } of [other, plain, laptop]) server.close()
  }
})

it('links this machine’s projects at loopback from a loopback page, else at the URL they advertise, and others at theirs', () => {
  const local = {
    name: 'other',
    url: 'http://127.0.0.1:4748',
    tailnet: 'https://box.tail.ts.net:4749',
    current: false,
    available: true,
  }
  expect(href(local, '127.0.0.1')).toBe('http://127.0.0.1:4748/')
  expect(href(local, 'localhost')).toBe('http://127.0.0.1:4748/')
  // The supervisor opens its app window on ultimate.localhost.
  expect(href(local, 'ultimate.localhost')).toBe('http://127.0.0.1:4748/')
  // The port Serve assigned, never the loopback port on the page's host.
  expect(href(local, 'box.tail.ts.net')).toBe('https://box.tail.ts.net:4749/')
  expect(href({ ...local, tailnet: undefined }, 'box.tail.ts.net')).toBeUndefined()
  // A configured URL with a trailing slash opens its root once.
  const remote = { ...local, machine: 'laptop', url: 'https://laptop.tail.ts.net:4747/' }
  expect(href(remote, 'box.tail.ts.net')).toBe('https://laptop.tail.ts.net:4747/')
  expect(href(remote, '127.0.0.1')).toBe('https://laptop.tail.ts.net:4747/')
})
