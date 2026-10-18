import React, { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, qs } from '../api.js';
import { Status, Priority, ago, isOverdue, useDebounced, STATUS_LABEL, TYPE_LABEL, PRIORITIES } from '../ui.jsx';

const VIEWS = [
  ['assigned_to_me', 'Assigned to me'], ['unassigned_urgent', 'Unassigned urgent'],
  ['awaiting_my_approval', 'Awaiting my approval'], ['all', 'All items'],
];

export default function Dashboard({ user }) {
  const [view, setView] = useState('assigned_to_me');
  const [f, setF] = useState({ q: '', status: '', priority: '', type: '', team_id: '', overdue: '' });
  const q = useDebounced(f.q);
  const params = { ...f, q, view, limit: 25 };

  const counts = useQuery({ queryKey: ['dashboard'], queryFn: () => api('GET', '/dashboard'), refetchInterval: 20000 });
  const list = useInfiniteQuery({
    queryKey: ['items', params],
    queryFn: ({ pageParam }) => api('GET', `/items?${qs({ ...params, cursor: pageParam })}`),
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: 20000, // polling instead of websockets (documented trade-off)
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <div className="tabs">
        {VIEWS.map(([v, label]) => (
          <button key={v} className={view === v ? 'tab active' : 'tab'} onClick={() => setView(v)}>
            {label}{v !== 'all' && counts.data && <b className="badge-count">{counts.data[v]}</b>}
          </button>
        ))}
        {counts.data?.overdue > 0 && (
          <button className={f.overdue ? 'tab active danger' : 'tab danger'} onClick={() => setF({ ...f, overdue: f.overdue ? '' : 'true' })}>
            Overdue<b className="badge-count">{counts.data.overdue}</b>
          </button>)}
      </div>
      <div className="filters">
        <input placeholder="Search title/description or #id…" value={f.q} onChange={set('q')} />
        <select value={f.status} onChange={set('status')}><option value="">Any status</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={f.priority} onChange={set('priority')}><option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
        <select value={f.type} onChange={set('type')}><option value="">Any type</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={f.team_id} onChange={set('team_id')}><option value="">All my teams</option>{user.memberships.map((m) => <option key={m.team_id} value={m.team_id}>{m.team_name}</option>)}</select>
      </div>

      {list.isLoading && <p className="pad">Loading…</p>}
      {list.error && <p className="error pad">{list.error.message} <button className="link" onClick={() => list.refetch()}>Retry</button></p>}
      {!list.isLoading && !items.length && <p className="muted pad">Nothing here. 🎉</p>}
      <table className="items">
        <tbody>
          {items.map((i) => (
            <tr key={i.id} onClick={() => (location.hash = `#/items/${i.id}`)}>
              <td className="muted">#{i.id}</td>
              <td><a href={`#/items/${i.id}`}>{i.title}</a><div className="muted small">{i.team_name} · {TYPE_LABEL[i.type]}</div></td>
              <td><Priority p={i.priority} /></td>
              <td><Status s={i.status} /></td>
              <td>{i.assignee_name ?? <i className="muted">unassigned</i>}</td>
              <td className={isOverdue(i) ? 'error' : 'muted'}>{i.due_date ? `due ${i.due_date}` : ''}</td>
              <td className="muted small">{ago(i.updated_at)}</td>
            </tr>))}
        </tbody>
      </table>
      {list.hasNextPage && <button className="btn" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>}
    </>
  );
}
