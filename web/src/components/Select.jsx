import React, { useId } from 'react';

// options : [{ value, label, disabled? }]
export default function Select({ label, value, onChange, options, disabled = false, hint, className = '', hideLabel = false }) {
  const id = useId();
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'field-label'}>{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}
