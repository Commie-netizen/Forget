import React from 'react';

// Accessible toggle (role=switch). `label` supplies the aria-label when no text is visible.
export default function Toggle({ checked, onChange, label, disabled = false, id }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" aria-hidden="true" />
    </button>
  );
}
