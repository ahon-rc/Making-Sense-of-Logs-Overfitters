// Calls to the logsense FastAPI backend (app/server.py). Vite proxies /api to it in development.

export type Query = { sql: string; ms: number; rows: number }

export type Role = { id: string; title: string; level: string; question: string }

export type SavedRun = {
  id: string
  role: string | null
  title: string
  question: string
  source: string
  mtime: number
}

export type Status = {
  db: {
    ok: boolean
    version?: string
    error?: string
    tables?: Record<string, number | null>
    search_index?: boolean
  }
  claude: string | null
  mcp_config: boolean
  csv: Record<string, boolean>
}

export type Headline = Record<string, unknown>

export type ToolResult = {
  headline: Headline
  rows_preview: Record<string, unknown>[]
  queries: Query[]
  error?: string | null
}

// Events from /api/ask and /api/replay, as produced by logsense/agent.py Transcript.feed.
export type AskEvent =
  | { type: 'start'; role: string | null; question: string; replay?: string }
  | { type: 'note'; text: string }
  | { type: 'tool_call'; id: string; tool: string; args: Record<string, unknown> }
  | ({ type: 'tool_result'; id: string; tool: string } & ToolResult)
  | { type: 'final'; answer: string; tool_calls: number; duration_ms: number | null; cost_usd: number | null }
  | { type: 'saved'; path: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

const errorDetail = async (res: Response) => {
  const data = (await res.json().catch(() => ({}))) as { detail?: string }
  return data.detail || res.statusText || `Request failed with status ${res.status}.`
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  if (!res.ok) throw new Error(await errorDetail(res))
  return (await res.json()) as T
}

// Read a server-sent-event stream from a POST request and yield each JSON event.
export async function* streamEvents<E = AskEvent>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<E> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(await errorDetail(res))
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) yield JSON.parse(line.slice(6)) as E
      }
    }
  }
}

export const fmt = (n: unknown) =>
  typeof n === 'number' ? n.toLocaleString('en-US') : n == null ? '' : String(n)
