import { useRef, useState, type ReactNode } from 'react'
import { fmt, streamEvents, type Status } from './api'
import { cn } from './lib/utils'

// Port of the old Setup tab: what is ready, and one button that runs scripts/setup_db.py via /api/setup.

type SetupEvent = { type: 'line'; text: string } | { type: 'done'; ok: boolean }

type SetupProps = {
  status: Status | null
  onRecheck: () => void
}

const Checklist = ({ status }: { status: Status | null }) => {
  if (!status) return <p className="muted small">Checking…</p>
  const db = status.db
  const t = db.tables ?? {}
  const csvReady = !!(status.csv['openstack.csv'] && status.csv['bgl.csv'])
  const items: [boolean, string, ReactNode][] = [
    [
      db.ok,
      'SereneDB reachable on localhost:7890',
      db.ok ? db.version : (
        <>
          Start it with <code>docker compose up -d</code>. ({db.error})
        </>
      ),
    ],
    [
      csvReady,
      'CSVs prepared in data/',
      csvReady ? 'data/openstack.csv, data/bgl.csv' : 'Put the raw logs in data/ (see data/README.md), then run setup.',
    ],
    [
      !!(t.openstack_logs && t.bgl_logs),
      'Logs loaded',
      t.openstack_logs ? `${fmt(t.openstack_logs)} OpenStack + ${fmt(t.bgl_logs)} BGL rows` : 'Run setup.',
    ],
    [!!t.team_ownership, 'Team-ownership table', t.team_ownership ? `${t.team_ownership} component → team rows` : 'Created by setup.'],
    [!!db.search_index, 'Full-text search indexes', db.search_index ? 'openstack_search, bgl_search' : 'Created by setup.'],
    [
      !!status.claude,
      'Claude Code CLI',
      status.claude ?? (
        <>
          Install Claude Code and run <code>claude</code> once to sign in.
        </>
      ),
    ],
    [status.mcp_config, '.mcp.json present', 'Lets Claude Code start the serenedb-logs MCP server.'],
  ]
  return (
    <ul className="checklist">
      {items.map(([ok, label, hint]) => (
        <li key={label}>
          <span className={cn('dot', ok ? 'dot-ok' : 'dot-bad')} aria-label={ok ? 'ready' : 'missing'} />
          <div>
            <div>{label}</div>
            <div className="muted small">{hint}</div>
          </div>
        </li>
      ))}
    </ul>
  )
}

export const Setup = ({ status, onRecheck }: SetupProps) => {
  const [download, setDownload] = useState(false)
  const [reconvert, setReconvert] = useState(false)
  const [running, setRunning] = useState(false)
  const [state, setState] = useState('')
  const [log, setLog] = useState<string[]>([])
  const logRef = useRef<HTMLPreElement>(null)

  const runSetup = async () => {
    setRunning(true)
    setLog([])
    setState('running')
    try {
      for await (const ev of streamEvents<SetupEvent>('/api/setup', { download, reconvert })) {
        if (ev.type === 'line') {
          setLog((lines) => [...lines, ev.text])
          requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }))
        } else if (ev.type === 'done') {
          setState(ev.ok ? 'Finished.' : 'Failed: see the output.')
        }
      }
    } catch (err) {
      setState(`Error: ${(err as Error).message}`)
    } finally {
      setRunning(false)
      onRecheck()
    }
  }

  return (
    <div className="dashboard">
      <div className="grid2">
        <section className="panel">
          <h3>Checklist</h3>
          <Checklist status={status} />
          <button type="button" className="ghost-button" onClick={onRecheck}>
            Check again
          </button>
        </section>
        <section className="panel">
          <h3>Build the database</h3>
          <p className="muted small">
            Runs <code>scripts/setup_db.py</code>: converts the raw logs in <code>data/</code> to CSV if needed, loads
            them into SereneDB, adds the team-ownership table and search indexes, then prints the checks.
          </p>
          <label className="check">
            <input type="checkbox" checked={download} onChange={(e) => setDownload(e.target.checked)} />
            Download the raw logs from Zenodo first
          </label>
          <label className="check">
            <input type="checkbox" checked={reconvert} onChange={(e) => setReconvert(e.target.checked)} />
            Rebuild the CSVs even if they exist
          </label>
          <div className="setup-actions">
            <button type="button" className="primary-button" onClick={() => void runSetup()} disabled={running}>
              Run setup
            </button>
            <span className="muted small">
              {running && <span className="spinner" aria-hidden="true" />}
              {state}
            </span>
          </div>
        </section>
      </div>
      <section className="panel">
        <h3>Output</h3>
        <pre className="console" ref={logRef}>
          {log.length ? log.join('\n') : 'Nothing run yet.'}
        </pre>
      </section>
      <section className="panel">
        <h3>Using the same tools from Claude Code</h3>
        <p className="small">
          Run <code>claude</code> in the repo folder. It reads <code>.mcp.json</code> and starts the{' '}
          <code>serenedb-logs</code> MCP server itself. Then use <code>/mcp__serenedb-logs__engineer</code>,{' '}
          <code>/mcp__serenedb-logs__team_lead</code> or <code>/mcp__serenedb-logs__manager</code>, or just ask a
          question.
        </p>
      </section>
    </div>
  )
}
