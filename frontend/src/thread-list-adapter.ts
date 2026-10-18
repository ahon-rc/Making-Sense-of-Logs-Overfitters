import { createAssistantStream } from 'assistant-stream'
import { InMemoryThreadListAdapter, type ThreadMessage } from '@assistant-ui/react'

const TITLE_WORD_LIMIT = 4

const getMessageText = (message: ThreadMessage) =>
  message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')

// Titles come from the first few words of the first user message.
const generateShortTitle = (_remoteId: string, messages: readonly ThreadMessage[]) => {
  const firstUserMessage = messages.find((message) => message.role === 'user')
  const words = firstUserMessage
    ? getMessageText(firstUserMessage).trim().split(/\s+/).filter(Boolean)
    : []

  const title =
    words.length > TITLE_WORD_LIMIT
      ? `${words.slice(0, TITLE_WORD_LIMIT).join(' ')}...`
      : words.join(' ') || 'New chat'

  return Promise.resolve(
    createAssistantStream((controller) => {
      controller.appendText(title)
    }),
  )
}

export const createThreadListAdapter = () =>
  Object.assign(new InMemoryThreadListAdapter(), { generateTitle: generateShortTitle })
