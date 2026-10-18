import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ThreadAssistantMessagePart,
  ToolCallMessagePart,
} from '@assistant-ui/react'
import { streamEvents, type ToolResult } from './api'

export type AnswerMeta = {
  toolCalls?: number
  durationMs?: number | null
  costUsd?: number | null
  savedPath?: string
  replayOf?: string
}

// Set from App: the role the next question is asked as, and a saved answer to replay instead of asking.
let activeRole: string | null = null
let pendingReplay: string | null = null
let onSaved: (() => void) | null = null

export const setActiveRole = (role: string | null) => {
  activeRole = role
}

export const queueReplay = (runId: string) => {
  pendingReplay = runId
}

export const setOnSaved = (callback: (() => void) | null) => {
  onSaved = callback
}

export const QUERIES_HEADING = /^#{1,3}\s*queries\b/im

const getTextContent =(message: ChatModelRunOptions['messages'][number]) =>
  message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')

// Streams /api/ask (or /api/replay): tool calls and their SQL appear live, then the answer.
export const logsenseChatModel: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const replay = pendingReplay
    pendingReplay = null
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    const question = lastUser ? getTextContent(lastUser).trim() : ''

    const events = replay
      ? streamEvents('/api/replay', { id: replay }, abortSignal)
      : streamEvents('/api/ask', { role: activeRole, question }, abortSignal)

    let parts: ThreadAssistantMessagePart[] = []
    const meta: AnswerMeta = replay ? { replayOf: replay } : {}

    for await (const ev of events) {
      if (ev.type === 'note') {
        parts = [...parts, { type: 'reasoning', text: ev.text }]
      } else if (ev.type === 'tool_call') {
        const call: ToolCallMessagePart = {
          type: 'tool-call',
          toolCallId: ev.id,
          toolName: ev.tool,
          args: ev.args as ToolCallMessagePart['args'],
          argsText: JSON.stringify(ev.args),
        }
        parts = [...parts, call]
      } else if (ev.type === 'tool_result') {
        const result: ToolResult = {
          headline: ev.headline,
          rows_preview: ev.rows_preview,
          queries: ev.queries,
          error: ev.error,
        }
        parts = parts.map((part) =>
          part.type === 'tool-call' && part.toolCallId === ev.id
            ? { ...part, result, isError: !!ev.error }
            : part,
        )
      } else if (ev.type === 'final') {
        // Claude's last text block is the answer itself: show it once, as the answer.
        const last = parts.at(-1)
        if (last?.type === 'reasoning' && ev.answer.trim().startsWith(last.text.trim().slice(0, 80))) {
          parts = parts.slice(0, -1)
        }
        // The closing "Queries" section is for checking: it becomes its own part, rendered collapsed.
        const split = ev.answer.search(QUERIES_HEADING)
        parts =
          split > 0
            ? [
                ...parts,
                { type: 'text', text: ev.answer.slice(0, split).trimEnd() },
                { type: 'text', text: ev.answer.slice(split) },
              ]
            : [...parts, { type: 'text', text: ev.answer }]
        meta.toolCalls = ev.tool_calls
        meta.durationMs = ev.duration_ms
        meta.costUsd = ev.cost_usd
      } else if (ev.type === 'saved') {
        meta.savedPath = ev.path
        onSaved?.()
      } else if (ev.type === 'error') {
        throw new Error(ev.message)
      } else {
        continue
      }
      yield { content: parts, metadata: { custom: { ...meta } } }
    }

    if (!parts.some((part) => part.type === 'text')) {
      throw new Error('Claude did not return an answer.')
    }
    yield {
      content: parts,
      status: { type: 'complete', reason: 'stop' },
      metadata: { custom: { ...meta } },
    }
  },
}
