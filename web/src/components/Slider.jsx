import React, { useId } from 'react';

export default function Slider({ label, value, min, max, step = 1, unit = '', onChange, disabled = false, hint }) {
  const id = useId();
  return (
    <div className="field slider">
      <div className="slider-head">
        <label htmlFor={id} className="field-label">{label}</label>
        <output htmlFor={id} className="slider-value">{value}{unit}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="slider-scale muted small" aria-hidden="true">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}
