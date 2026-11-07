import React from 'react';
import Icon from './Icon.jsx';

export default function EmptyState({ icon = 'archive', title, children, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true"><Icon name={icon} size={26} /></div>
      {title && <div className="empty-title">{title}</div>}
      {children && <p className="muted small">{children}</p>}
      {action}
    </div>
  );
}
