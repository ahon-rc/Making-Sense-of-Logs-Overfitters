import type { ReactNode } from 'react'
import { fmt } from '@/api'
import { cn } from '@/lib/utils'

type Row = Record<string, unknown>

export type Column = {
  key: string
  label: string
  render?: (row: Row) => unknown
  className?: string
}

const cell = (value: unknown): ReactNode =>
  typeof value === 'number'
    ? fmt(value)
    : Array.isArray(value)
      ? value.join(', ')
      : typeof value === 'boolean'
        ? String(value)
        : value == null
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value)

export const DataTable = ({ rows, columns }: { rows?: Row[]; columns?: Column[] }) => {
  if (!rows?.length) return <p className="muted small">No rows.</p>
  const cols: Column[] = columns ??Object.keys(rows[0]).map((key) => ({ key, label: key }))
  const valueOf = (col: Column, row: Row) => (col.render ? col.render(row) : row[col.key])
  const numeric = (col: Column) => typeof valueOf(col, rows[0]) === 'number'

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {cols.map((col) => (
              <th key={col.key} className={cn(numeric(col) && 'num')}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map((col) => {
                const value = valueOf(col, row)
                return (
                  <td key={col.key} className={cn(typeof value === 'number' ? 'num' : col.className)}>
                    {cell(value)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
