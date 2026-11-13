/** Where a rail tile links, from the page's host. Browser-safe. */
import type { RunningProject } from './refs.ts'

/** A page on this machine's loopback, including the supervisor's `ultimate.localhost` app window. */
const loopback = (hostname: string) =>
  /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(hostname)

/**
 * The root a tile opens from a page on `hostname`: another machine's instance at its configured URL; one on this
 * machine at its loopback URL from a loopback page, else at the Tailscale URL it advertises, or nowhere when it
 * advertises none.
 */
export function href(project: RunningProject, hostname: string): string | undefined {
  const url = project.machine !== undefined || loopback(hostname) ? project.url : project.tailnet
  return url && `${url.replace(/\/+$/, '')}/`
}
