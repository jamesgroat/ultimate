import { hostname } from 'node:os'
import { exec } from './exec.ts'
import { readSettings, userSettingsPath } from './settings.ts'

const named = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

async function configuredNames(userHome: string, env: NodeJS.ProcessEnv) {
  const reportedInvalidSettingsMeanUnset = () => ({})
  const settings: Record<string, unknown> = await readSettings(userSettingsPath(userHome)).catch(
    reportedInvalidSettingsMeanUnset,
  )
  const cloud = settings.cloud
  const cloudMachine =
    cloud && typeof cloud === 'object' && !Array.isArray(cloud)
      ? (cloud as Record<string, unknown>).machine
      : undefined
  const pinned = [env.ULTIMATE_MACHINE, env.ULTIMATE_CLOUD_MACHINE, settings.machine].flatMap(
    (value) => named(value) ?? [],
  )
  const cloudName = named(cloudMachine)
  return { pinned: pinned[0], all: cloudName ? [...pinned, cloudName] : pinned }
}

export async function pinnedMachineName(userHome: string, env: NodeJS.ProcessEnv = process.env) {
  return (await configuredNames(userHome, env)).pinned
}

export async function machineName(userHome: string, env: NodeJS.ProcessEnv = process.env) {
  return (await configuredNames(userHome, env)).all[0] ?? hostname()
}

let localHostName: Promise<string | undefined> | undefined
const macLocalHostName = () =>
  (localHostName ??=
    process.platform === 'darwin'
      ? exec('scutil', ['--get', 'LocalHostName'], { timeout: 5000 }).then(
          ({ stdout }) => named(stdout),
          () => undefined,
        )
      : Promise.resolve(undefined))

export async function isThisMachine(
  userHome: string,
  machine: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const local = await macLocalHostName()
  const names = [
    ...(await configuredNames(userHome, env)).all,
    hostname(),
    hostname().split('.')[0],
    ...(local ? [local, `${local}.local`] : []),
  ]
  return names.some((name) => name.toLowerCase() === machine.trim().toLowerCase())
}
