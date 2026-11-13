/** Projects in the browser: the Ultimate instances running on this machine and the user's other machines, for the rail. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** One running instance: its project's name, where it answers, and its live state when it answered. */
export type RunningProject = {
  name: string
  /** The machine it runs on, as `remotes` in user settings names it; absent for this machine. */
  machine?: string
  /** This machine's instance: its loopback URL. Another machine's: the URL set in `remotes`. */
  url: string
  /** This machine's instance: the full Tailscale URL it advertises while published; absent when it is not. */
  tailnet?: string
  /** The instance this page shows. */
  current: boolean
  /** Whether its `status` answered in time; when it did not, it has no `busy` or `questions`. */
  available: boolean
  /** Conversations running a turn now. */
  busy?: number
  /** Messages waiting on the user's answer. */
  questions?: number
}

/** No arguments → every running instance on this machine, this one included, in project order, then the other machines'. */
export const ListAction = actionRef<null, RunningProject[]>('projects', 'list')

/** `{ pinned? }` → whether the rail stays open, shared by every instance on this machine; `pinned` sets it first. */
export const PinAction = actionRef<{ pinned?: boolean }, { pinned: boolean }>('projects', 'pin')
