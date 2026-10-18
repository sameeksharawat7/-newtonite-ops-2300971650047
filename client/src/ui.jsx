import React from 'react';

export const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', awaiting_approval: 'Awaiting approval', resolved: 'Resolved', closed: 'Closed' };
export const TYPE_LABEL = { incident: 'Incident', customer_issue: 'Customer issue', payment: 'Payment', compliance: 'Compliance', task: 'Task' };
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const Status = ({ s }) => <span className={`pill st-${s}`}>{STATUS_LABEL[s]}</span>;
export const Priority = ({ p }) => <span className={`pill pr-${p}`}>{p}</span>;
export const ago = (iso) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
};
export const isOverdue = (i) => i.due_date && i.due_date < new Date().toISOString().slice(0, 10) && !['resolved', 'closed'].includes(i.status);
export const useDebounced = (v, ms = 300) => {
  const [d, setD] = React.useState(v);
  React.useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
};
