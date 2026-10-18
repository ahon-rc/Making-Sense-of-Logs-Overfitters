import { useState } from 'react'
import { fmt } from '@/api'

type Bar = { label: string; value: number; detail?: string }

type BarChartProps = {
  bars: Bar[]
  orientation?: 'horizontal' | 'vertical'
  ariaLabel: string
}

// A single-series bar chart in plain HTML: thin bars, one hue, a tooltip on hover or focus.
export const BarChart = ({ bars, orientation = 'horizontal', ariaLabel }: BarChartProps) => {
  const [active, setActive] = useState<number | null>(null)
  if (!bars.length) return <p className="muted small">No data.</p>
  const max = Math.max(...bars.map((bar) => bar.value), 1)
  const tip = active !== null ? bars[active] : null

  if (orientation === 'horizontal') {
    return (
      <div className="hbar-chart" role="list" aria-label={ariaLabel}>
        {bars.map((bar, i) => (
          <div
            key={bar.label}
            className="hbar-row"
            role="listitem"
            tabIndex={0}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            data-active={active === i || undefined}
          >
            <span className="hbar-label" title={bar.label}>
              {bar.label}
            </span>
            <span className="hbar-track">
              <span className="hbar-fill" style={{ width: `${(100 * bar.value) / max}%` }} />
            </span>
            <span className="hbar-value">{fmt(bar.value)}</span>
          </div>
        ))}
        {tip?.detail && <div className="chart-caption">{tip.label}: {tip.detail}</div>}
      </div>
    )
  }

  // Vertical bars over time: labels only at the ends, the hovered bucket in the caption.
  return (
    <div className="vbar-chart" aria-label={ariaLabel} role="img">
      <div className={bars.length > 60 ? 'vbar-plot vbar-plot-dense' : 'vbar-plot'} onMouseLeave={() => setActive(null)}>
        {bars.map((bar, i) => (
          <span
            key={bar.label}
            className="vbar-slot"
            onMouseEnter={() => setActive(i)}
            data-active={active === i || undefined}
          >
            <span className="vbar-fill" style={{ height: `${Math.max((100 * bar.value) / max, 1)}%` }} />
          </span>
        ))}
      </div>
      <div className="vbar-axis">
        <span>{bars[0].label}</span>
        <span>{bars.at(-1)!.label}</span>
      </div>
      <div className="chart-caption" aria-live="polite">
        {tip ? `${tip.label}: ${fmt(tip.value)} lines` : `max ${fmt(max)} lines per bucket · hover a bar for its value`}
      </div>
    </div>
  )
}
