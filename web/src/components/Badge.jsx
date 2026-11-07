import React from 'react';
import { JOB_LABEL, JOB_TONE } from '../lib.js';

// tone : neutral | blue | green | red | orange | pink | navy
export default function Badge({ tone = 'neutral', children, title }) {
  return <span className={`badge tone-${tone}`} title={title}>{children}</span>;
}

export function StatusBadge({ value }) {
  return <Badge tone={JOB_TONE[value] || 'neutral'}>{JOB_LABEL[value] || value || '-'}</Badge>;
}
