import React from 'react';
import Icon from './Icon.jsx';

export function Card({ title, subtitle, actions, children, className = '', as: Tag = 'section', ...rest }) {
  return (
    <Tag className={`card ${className}`} {...rest}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="muted small card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </Tag>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

// Bandeau d'information / d'erreur. tone : info | warn | error | ok
export function Notice({ tone = 'info', title, children, action }) {
  if (!children && !title) return null;
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'ok' ? 'check' : 'warn'} size={16} />
      <div className="grow">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Stat({ label, value, hint }) {
  return (
    <div className="card stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
}

export function Spinner({ label = 'Chargement...' }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted small">{label}</span>
    </div>
  );
}
