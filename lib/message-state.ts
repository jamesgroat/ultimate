type Status = { reply: boolean; state: string; to: number | 'user' | 'remote' }

export const isOpen = (message: Status) =>
  message.reply && (message.state === 'sent' || message.state === 'delivered')

export const isOwed = (message: Status) => message.reply && message.state === 'delivered'

export const openQuestion = (message: Status) => message.to === 'user' && isOwed(message)

type Served = {
  message: number
  from: number | 'remote'
  remote?: { project: string; machine: string }
}

export function handoverLine(work: string, serves: Served | undefined) {
  if (!serves) return ''
  const asker = serves.remote
    ? `@ultimate@${serves.remote.project} on ${serves.remote.machine}`
    : `#${serves.from}`
  return `\n${work} now works on ${asker}'s message ${serves.message}: your own answer to it becomes interim, and ${work}'s result answers it. Pass serves: false to start unrelated work without handing it over.`
}
