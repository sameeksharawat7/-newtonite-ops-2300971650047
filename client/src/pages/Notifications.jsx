import React, { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { ago } from '../ui.jsx';

export default function Notifications() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['notifications'], queryFn: () => api('GET', '/notifications') });
  useEffect(() => { if (data?.unread) api('POST', '/notifications/read').then(() => setTimeout(() => qc.invalidateQueries({ queryKey: ['notifications'] }), 1500)); }, [data?.unread]);
  if (isLoading) return <p className="pad">Loading…</p>;
  return (
    <div className="card">
      <h2>Notifications</h2>
      <p className="muted small">Created asynchronously by the background worker (outbox pattern).</p>
      {!data.notifications.length && <p className="muted">Nothing yet.</p>}
      <ul className="plain">{data.notifications.map((n) => (
        <li key={n.id} className={n.read_at ? '' : 'unread'}>
          <a href={`#/items/${n.item_id}`}>{n.message}</a> <span className="muted small">{ago(n.created_at)}</span>
        </li>))}</ul>
    </div>
  );
}
