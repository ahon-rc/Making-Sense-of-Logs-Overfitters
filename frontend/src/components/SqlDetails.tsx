import { fmt, type Query } from '@/api'

// The SQL SereneDB ran for a result, one click away.
export const SqlDetails = ({ queries }: { queries?: Query[] }) => {
  if (!queries?.length) return null
  const total = queries.reduce((sum, q) => sum + (q.ms || 0), 0)
  return (
    <details className="sql-details">
      <summary>
        SQL ({queries.length} quer{queries.length === 1 ? 'y' : 'ies'}, {total.toFixed(1)} ms)
      </summary>
      {queries.map((q, i) => (
        <div key={i}>
          <div className="sql-ms">
            {q.ms} ms · {fmt(q.rows)} row{q.rows === 1 ? '' : 's'}
          </div>
          <pre className="sql">{q.sql}</pre>
        </div>
      ))}
    </details>
  )
}
