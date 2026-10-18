import type { ToolCallMessagePartComponent } from '@assistant-ui/react'
import { fmt, type Headline, type ToolResult } from '@/api'
import { DataTable } from './DataTable'
import { SqlDetails } from './SqlDetails'

const HEADLINE_LABELS: Record<string, string> = {
  total_matching_lines: 'matching lines',
  total_lines_in_window: 'lines in window',
  total_lines_in_scope: 'lines in scope',
  total_groups: 'groups',
  total_lines: 'lines',
  buckets_with_data: 'buckets',
  returned: 'returned',
}

const argText = (args: Record<string, unknown>) =>
  Object.entries(args ?? {})
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ')

type Bucket = { min: number; max: number; median: number }
type Summary = { lines: number; labelled_anomaly: boolean }
type Group = Record<string, unknown> & { n: number; avg_s: number; p95_s: number }

const headlineChips = (h: Headline) => {
  const chips: { text: string; warn?: boolean }[] = []
  for (const [key, label] of Object.entries(HEADLINE_LABELS)) {
    if (key in h) chips.push({ text: `${fmt(h[key])} ${label}` })
  }
  const perBucket = h.lines_per_bucket as Bucket | undefined
  if (perBucket) {
    chips.push({ text: `per bucket ${perBucket.min}–${perBucket.max} (median ${perBucket.median})` })
  }
  const summary = h.summary as Summary | undefined
  if (summary) {
    chips.push({
      text: `${fmt(summary.lines)} lines · ${summary.labelled_anomaly ? 'labelled anomaly' : 'not labelled'}`,
    })
  }
  for (const g of (h.groups as Group[] | undefined) ?? []) {
    chips.push({ text: `${Object.values(g)[0]}: n=${fmt(g.n)}, avg ${g.avg_s}s, p95 ${g.p95_s}s` })
  }
  if (h.truncated) chips.push({ text: 'truncated: sample shown', warn: true })
  return chips
}

const shorten = (rows: Record<string, unknown>[]) =>
  rows.map((row) =>
    typeof row.message === 'string' && row.message.length > 160
      ? { ...row, message: `${row.message.slice(0, 160)}…` }
      : row,
  )

// One MCP tool call Claude made: its arguments, headline numbers, a few rows and the SQL behind them.
export const ToolCallCard: ToolCallMessagePartComponent = ({ toolName, args, result, status }) => {
  const res = result as ToolResult | undefined
  const state = res ? (res.error ? 'error' : 'done') : status.type === 'running' ? 'running' : 'no result'
  const chips = res ? headlineChips(res.headline ?? {}) : []

  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <span className="tool-card-name">{toolName}</span>
        <span className="tool-card-args">{argText(args as Record<string, unknown>)}</span>
        <span className={`tool-card-state tool-card-state-${state.replace(' ', '-')}`}>
          {state === 'running' && <span className="spinner" aria-hidden="true" />}
          {state}
        </span>
      </div>
      {res && (
        <div className="tool-card-body">
          {(res.error || chips.length > 0) && (
            <div className="chips">
              {res.error && <span className="chip chip-warn">{res.error}</span>}
              {chips.map((chip, i) => (
                <span key={i} className={chip.warn ? 'chip chip-warn' : 'chip'}>
                  {chip.text}
                </span>
              ))}
            </div>
          )}
          {res.rows_preview?.length > 0 && (
            <details className="sql-details">
              <summary>First {res.rows_preview.length} rows</summary>
              <DataTable rows={shorten(res.rows_preview)} />
            </details>
          )}
          <SqlDetails queries={res.queries} />
        </div>
      )}
    </div>
  )
}
