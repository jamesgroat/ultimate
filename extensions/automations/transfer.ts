import { constants } from 'node:fs'
import { access, cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isMissing } from '../../lib/errors.ts'
import type { Automation, Subscriber } from './types.ts'

export type ScriptTransfer = {
  id: string
  name: string
  source: string
  automation: Pick<Automation, 'name' | 'schedule' | 'prompt' | 'agent' | 'model' | 'thinking'> & {
    script: Pick<NonNullable<Automation['script']>, 'ask' | 'once' | 'secrets' | 'timeout'>
  }
  subscribers: string[]
  error?: string
}

export function transferSubscribers(subscribers: Subscriber[], standing: Record<string, number>) {
  return subscribers.map((subscriber) => {
    if (typeof subscriber === 'string') return subscriber
    const name = Object.keys(standing).find((key) => standing[key] === subscriber)
    if (!name) throw new Error(`Subscriber #${subscriber} is not a standing agent`)
    return `@${name}`
  })
}

async function stateExists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (!isMissing(error)) throw error
    return false
  }
}

export async function validateTransfer(source: string) {
  const root = dirname(source)
  for (const entry of await readdir(root))
    if (!['run', 'state', 'pid', 'output.log'].includes(entry))
      throw new Error(`Unsupported script file: ${join(root, entry)}`)
  const executable = await lstat(source)
  if (!executable.isFile() || executable.nlink !== 1)
    throw new Error(`Script must be a regular, unlinked file: ${source}`)
  await access(source, constants.X_OK)
  async function tree(path: string): Promise<void> {
    const entry = await lstat(path)
    if (entry.isDirectory()) {
      for (const name of await readdir(path)) await tree(join(path, name))
    } else if (!entry.isFile() || entry.nlink !== 1)
      throw new Error(`Unsupported script state: ${path}`)
  }
  const state = join(root, 'state')
  if (await stateExists(state)) await tree(state)
}

export async function copyTransfer(source: string, destination: string) {
  const root = dirname(destination)
  const staged = join(root, '.transfer')
  try {
    await access(destination)
    await rm(staged, { recursive: true, force: true })
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await validateTransfer(source)
  await mkdir(root, { recursive: true })
  await rm(staged, { recursive: true, force: true })
  await mkdir(join(staged, 'state'), { recursive: true })
  const sourceState = join(dirname(source), 'state')
  if (await stateExists(sourceState))
    await cp(sourceState, join(staged, 'state'), { recursive: true })
  await cp(source, join(staged, 'run'))
  await rm(join(root, 'state'), { recursive: true, force: true })
  await rename(join(staged, 'state'), join(root, 'state'))
  await rename(join(staged, 'run'), destination)
  await rm(staged, { recursive: true, force: true })
}
