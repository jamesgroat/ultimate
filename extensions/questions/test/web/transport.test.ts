import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { MessageQuestions } from '../../ui.tsx'
import type { MessageQuestionsTransport } from '../../ui.tsx'
import { AnswerAction, DismissAction } from '../../refs.ts'

vi.mock('../../../messages/ui.tsx', () => ({ MessagesDoc: { kind: 'messages' } }))
vi.mock('@/components/ai/message', () => ({ MessageResponse: () => null }))

const action = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ id: 99 })),
)
vi.mock('@/sdk', () => ({
  api: { action },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  useViewport: () => 'desktop',
  useDocOf: () => undefined,
  useConversation: () => 42,
}))

const message = {
  id: 7,
  from: 42,
  to: 'user' as const,
  reply: true,
  state: 'delivered',
  questions: [{ text: 'Keep it?', kind: 'confirm' as const }],
}
const answers = [{ question: 'Keep it?', answer: 'Yes' }]

beforeEach(() => action.mockClear())

it('routes the same numeric message ID through the injected peer transport and namespaced card', async () => {
  const peer: MessageQuestionsTransport = {
    answer: vi.fn<MessageQuestionsTransport['answer']>(async () => ({ id: 100 })),
    dismiss: vi.fn<MessageQuestionsTransport['dismiss']>(async () => ({ id: 101 })),
  }
  const card = MessageQuestions({
    message,
    keys: true,
    identity: 'inbox:["machine/project",7]',
    transport: peer,
  })!
  expect(renderToStaticMarkup(card)).toContain(
    'data-questions-card="inbox:[&quot;machine/project&quot;,7]"',
  )
  await card.props.submit(answers, 'Ship it', true)
  expect(peer.answer).toHaveBeenCalledWith(
    { messageId: 7, answers, note: 'Ship it' },
    { keepalive: true },
  )
  await card.props.reply('A plain reply')
  expect(peer.answer).toHaveBeenLastCalledWith({ messageId: 7, text: 'A plain reply' })
  await card.props.dismiss()
  expect(peer.dismiss).toHaveBeenCalledWith({ messageId: 7 })
  expect(action).not.toHaveBeenCalled()
})

it('keeps the local card identity and question actions when no transport is injected', async () => {
  const card = MessageQuestions({ message })!
  expect(renderToStaticMarkup(card)).toContain('data-questions-card="message:7"')
  await card.props.submit(answers, undefined, false)
  expect(action).toHaveBeenCalledWith(AnswerAction, { messageId: 7, answers }, { keepalive: false })
  await card.props.reply('Local reply')
  expect(action).toHaveBeenLastCalledWith(
    AnswerAction,
    { messageId: 7, text: 'Local reply' },
    undefined,
  )
  await card.props.dismiss()
  expect(action).toHaveBeenLastCalledWith(DismissAction, { messageId: 7 })
})
