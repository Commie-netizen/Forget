import React from 'react';

export default function Progress({ value = 0, max = 100, label, tone = 'blue', indeterminate = false }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className={`progress ${tone}${indeterminate ? ' indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : value}
    >
      <div className="progress-bar" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  );
}
