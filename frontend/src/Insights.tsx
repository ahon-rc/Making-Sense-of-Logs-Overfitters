import { useEffect, useState, type FormEvent } from 'react'
import { api, fmt, type Query } from './api'
import { BarChart } from './components/BarChart'
import { DataTable, type Column } from './components/DataTable'
import { SqlDetails } from './components/SqlDetails'

// Same queries the MCP tools run, called directly through /api/tools (no LLM in the loop).

type Dataset = 'openstack' | 'bgl'
type Row = Record<string, unknown>
type ToolResponse = { rows: Row[]; queries: Query[]; truncated?: boolean; returned?: number; total_groups?: number }

type Overview = {
  result: Record<
    Dataset,
    {
      rows: number
      first_ts: string
      last_ts: string
      rows_by_level: Record<string, number>
      labelled_anomaly_instances?: string[]
      alert_rows?: number
    }
  >
}

type Trend = ToolResponse & {
  total_lines: number
  buckets_with_data: number
  lines_per_bucket?: { min: number; max: number; median: number }
}

type Spawn = { groups: Row[]; slowest: Row[]; queries: Query[] }

type Search = ToolResponse & { total_matching_lines: number }

const NON_INFO: Record<Dataset, string[]> = {
  openstack: ['WARNING', 'ERROR', 'CRITICAL'],
  bgl: ['WARNING', 'SEVERE', 'ERROR', 'FAILURE', 'FATAL'],
}
const DEFAULT_TREND: Record<Dataset, string> = { openstack: '"unknown base file"', bgl: '' }

const tool = <T,>(name: string, args: Record<string, unknown>) => api<T>(`/api/tools/${name}`, args)

const span = (first: string, last: string) => {
  const [a, b] = [String(first), String(last)]
  return a.slice(0, 4) === b.slice(0, 4)
    ? [`${a.slice(5, 10)} → ${b.slice(5, 10)}`, `time span (${a.slice(0, 4)})`]
    : [`${a.slice(0, 7)} → ${b.slice(0, 7)}`, 'time span']
}

const time = (key: string, len: number): Column => ({
  key,
  label: key === 'ts' ? 'time' : key.replace('_', ' '),
  render: (r) => String(r[key]).slice(0, len),
})

const SEARCH_COLUMNS: Record<Dataset, Column[]> = {
  openstack: [
    time('ts', 23),
    { key: 'level', label: 'level' },
    { key: 'component', label: 'component' },
    { key: 'split', label: 'source', render: (r) => `${r.split}:${r.line_no}` },
    { key: 'message', label: 'message', className: 'msg' },
  ],
  bgl: [
    time('ts', 23),
    { key: 'level', label: 'level' },
    { key: 'component', label: 'component' },
    { key: 'node', label: 'node' },
    { key: 'message', label: 'message', className: 'msg' },
  ],
}

type Summary = { kpis: string[][]; teams: ToolResponse; patterns: ToolResponse }

export const Insights = () => {
  const [dataset, setDataset] = useState<Dataset>('openstack')
  // Each result remembers its dataset, so switching datasets shows loading until the new one arrives.
  const [loaded, setLoaded] = useState<{ dataset: Dataset; summary?: Summary; error?: string } | null>(null)
  const current = loaded?.dataset === dataset ? loaded : null
  const summary = current?.summary ?? null
  const error = current?.error ?? null

  useEffect(() => {
    let cancelled = false
    Promise.all([
      tool<Overview>('corpus_overview', {}),
      tool<ToolResponse>('count_by', { dataset, group_by: 'team', levels: NON_INFO[dataset] }),
      tool<ToolResponse>('count_by', {
        dataset,
        group_by: 'message_pattern',
        levels: NON_INFO[dataset],
        top: 10,
      }),
    ])
      .then(([overview, teams, patterns]) => {
        if (cancelled) return
        const o = overview.result[dataset]
        const nonInfo = Object.entries(o.rows_by_level)
          .filter(([level]) => level !== 'INFO')
          .reduce((sum, [, n]) => sum + n, 0)
        const kpis = [
          [fmt(o.rows), 'log lines'],
          span(o.first_ts, o.last_ts),
          [fmt(nonInfo), `non-INFO lines (${((100 * nonInfo) / o.rows).toFixed(2)}%)`],
          dataset === 'openstack'
            ? [String(o.labelled_anomaly_instances?.length ?? 0), 'labelled anomaly VMs']
            : [fmt(o.alert_rows), 'labelled alert lines'],
        ]
        setLoaded({ dataset, summary: { kpis, teams, patterns } })
      })
      .catch((err: Error) => !cancelled && setLoaded({ dataset, error: err.message }))
    return () => {
      cancelled = true
    }
  }, [dataset])

  const entity = dataset === 'openstack' ? 'distinct_instance_ids' : 'distinct_nodes'

  return (
    <div className="dashboard">
      <div className="dashboard-toolbar">
        <div className="seg" role="radiogroup" aria-label="Dataset">
          {(['openstack', 'bgl'] as const).map((ds) => (
            <button
              key={ds}
              type="button"
              role="radio"
              aria-checked={dataset === ds}
              onClick={() => setDataset(ds)}
            >
              {ds === 'openstack' ? 'OpenStack' : 'BGL'}
            </button>
          ))}
        </div>
        <span className="muted small">
          Same queries the MCP tools run, called directly. Non-INFO = everything except INFO.
        </span>
      </div>

      {error && (
        <div className="panel panel-error">Could not query SereneDB: {error}. Is the backend running?</div>
      )}

      {!error && (
        <>
          <div className="kpis">
            {(summary?.kpis ?? [['…', 'log lines'], ['…', 'time span'], ['…', 'non-INFO lines'], ['…', '']]).map(
              ([value, label], i) => (
                <div key={i} className="kpi">
                  <div className="kpi-value">{value}</div>
                  <div className="kpi-label">{label}</div>
                </div>
              ),
            )}
          </div>

          <div className="grid2">
            <section className="panel">
              <h3>Non-INFO lines by owning team</h3>
              {summary ? (
                <>
                  <BarChart
                    ariaLabel="Non-INFO lines by owning team"
                    bars={summary.teams.rows.map((r) => ({
                      label: String(r.team),
                      value: Number(r.lines),
                      detail: `${fmt(r.lines)} lines (${r.share_pct}%)`,
                    }))}
                  />
                  <SqlDetails queries={summary.teams.queries} />
                </>
              ) : (
                <Loading />
              )}
            </section>
            <TrendPanel key={dataset} dataset={dataset} />
          </div>

          <section className="panel">
            <h3>
              Top recurring problems{' '}
              <span className="muted small">
                non-INFO lines grouped by message pattern (ids and numbers masked)
              </span>
            </h3>
            {summary ? (
              <>
                <DataTable
                  rows={summary.patterns.rows}
                  columns={[
                    { key: 'message_pattern', label: 'pattern', className: 'msg' },
                    { key: 'teams', label: 'team' },
                    { key: 'lines', label: 'lines' },
                    { key: 'share_pct', label: 'share %' },
                    { key: entity, label: dataset === 'openstack' ? 'VMs' : 'nodes' },
                    time('first_seen', 16),
                    time('last_seen', 16),
                  ]}
                />
                {summary.patterns.truncated && (
                  <p className="muted small">
                    Showing {summary.patterns.returned} of {summary.patterns.total_groups} patterns.
                  </p>
                )}
                <SqlDetails queries={summary.patterns.queries} />
              </>
            ) : (
              <Loading />
            )}
          </section>

          {dataset === 'openstack' && <SpawnPanel />}
          <SearchPanel key={dataset} dataset={dataset} />
        </>
      )}
    </div>
  )
}

const Loading = () => (
  <p className="muted small">
    <span className="spinner" aria-hidden="true" /> Loading…
  </p>
)

const TrendPanel = ({ dataset }: { dataset: Dataset }) => {
  const [query, setQuery] = useState(DEFAULT_TREND[dataset])
  const [bucket, setBucket] = useState('day')
  const [request, setRequest] = useState({ query: DEFAULT_TREND[dataset], bucket: 'day' })
  // The last answer, with the request it answers: an older chart stays up while a new one loads.
  const [loaded, setLoaded] = useState<{ applied: typeof request; trend?: Trend; error?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const args: Record<string, unknown> = { dataset, bucket: request.bucket, levels: NON_INFO[dataset] }
    if (request.query.trim()) args.query = request.query.trim()
    tool<Trend>('trend', args)
      .then((trend) => !cancelled && setLoaded({ applied: request, trend }))
      .catch((err: Error) => !cancelled && setLoaded({ applied: request, error: err.message }))
    return () => {
      cancelled = true
    }
  }, [dataset, request])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setRequest({ query, bucket })
  }

  const applied = loaded?.applied ?? request
  const trend = loaded?.trend ?? null
  const error = loaded?.applied === request ? (loaded.error ?? null) : null
  const len = applied.bucket === 'hour' ? 16 : 10
  const per = trend?.lines_per_bucket
  return (
    <section className="panel">
      <h3>Trend</h3>
      <form className="inline-form" onSubmit={submit}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='full-text filter, e.g. "unknown base file"'
          aria-label="Trend filter"
        />
        <select value={bucket} onChange={(e) => setBucket(e.target.value)} aria-label="Bucket">
          <option value="hour">per hour</option>
          <option value="day">per day</option>
          <option value="week">per week</option>
        </select>
        <button type="submit">Update</button>
      </form>
      {error ? (
        <p className="error-text">{error}</p>
      ) : trend ? (
        <>
          <BarChart
            orientation="vertical"
            ariaLabel="Non-INFO lines over time"
            bars={trend.rows.map((r) => ({ label: String(r.bucket_start).slice(0, len), value: Number(r.lines) }))}
          />
          <p className="muted small">
            {fmt(trend.total_lines)} non-INFO lines{applied.query.trim() ? ` matching ${applied.query.trim()}` : ''} in{' '}
            {trend.buckets_with_data} non-empty buckets
            {per ? ` · per ${applied.bucket}: min ${per.min}, median ${per.median}, max ${per.max}` : ''}. Empty
            buckets are not shown.
          </p>
          <SqlDetails queries={trend.queries} />
        </>
      ) : (
        <Loading />
      )}
    </section>
  )
}

const SpawnPanel = () => {
  const [spawn, setSpawn] = useState<Spawn | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    tool<Spawn>('duration_stats', { metric: 'spawn_seconds', group_by: 'labelled_anomaly', slowest: 5 })
      .then(setSpawn)
      .catch((err: Error) => setError(err.message))
  }, [])

  return (
    <section className="panel">
      <h3>
        VM spawn time <span className="muted small">labelled anomaly VMs vs the rest</span>
      </h3>
      {error ? (
        <p className="error-text">{error}</p>
      ) : spawn ? (
        <>
          <DataTable
            rows={spawn.groups}
            columns={[
              {
                key: 'labelled_anomaly',
                label: 'group',
                render: (r) => (r.labelled_anomaly ? 'labelled anomaly VMs' : 'all other VMs'),
              },
              { key: 'n', label: 'spawns' },
              { key: 'avg_s', label: 'avg s' },
              { key: 'p50_s', label: 'median s' },
              { key: 'p95_s', label: 'p95 s' },
              { key: 'max_s', label: 'max s' },
            ]}
          />
          <p className="muted small">
            Slowest spawns:{' '}
            {spawn.slowest
              .map(
                (r) =>
                  `${String(r.instance_id).slice(0, 8)}… ${r.seconds}s${r.is_labelled_anomaly ? ' (labelled)' : ''}`,
              )
              .join(' · ')}
          </p>
          <SqlDetails queries={spawn.queries} />
        </>
      ) : (
        <Loading />
      )}
    </section>
  )
}

const SearchPanel = ({ dataset }: { dataset: Dataset }) => {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<Search | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const q = query.trim()
    if (!q) return
    setBusy(true)
    setError(null)
    try {
      setResult(await tool<Search>('search_logs', { query: q, dataset, limit: 50 }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h3>Search the logs</h3>
      <form className="inline-form" onSubmit={submit}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='full-text, e.g. "No valid host" or terminate'
          aria-label="Search query"
        />
        <button type="submit" disabled={busy}>
          Search
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {result && (
        <>
          <p className="muted small">
            {fmt(result.total_matching_lines)} matching lines in {dataset}
            {result.truncated ? `, showing the first ${result.returned}` : ''}.
          </p>
          <DataTable rows={result.rows} columns={SEARCH_COLUMNS[dataset]} />
          <SqlDetails queries={result.queries} />
        </>
      )}
    </section>
  )
}
