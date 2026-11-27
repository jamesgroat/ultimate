import { spawnSync } from 'node:child_process'
import { hostname, platform } from 'node:os'
import { readSettings, userSettingsPath } from './settings.ts'

let localHostName: string | undefined

export function machineHostname() {
  if (platform() !== 'darwin') return hostname()
  if (localHostName !== undefined) return localHostName
  const scutil = spawnSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' })
  const local = scutil.status === 0 ? scutil.stdout.trim() : ''
  if (!local) return hostname()
  localHostName = local
  return local
}

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
  return (await configuredNames(userHome, env)).all[0] ?? machineHostname()
}

export async function isThisMachine(
  userHome: string,
  machine: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const local = machineHostname()
  const names = [
    ...(await configuredNames(userHome, env)).all,
    local,
    hostname(),
    hostname().split('.')[0],
    ...(platform() === 'darwin' ? [`${local}.local`] : []),
  ]
  return names.some((name) => name.toLowerCase() === machine.trim().toLowerCase())
}
