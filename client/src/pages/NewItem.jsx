import React, { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { mutateApi, newKey } from '../api.js';
import { PRIORITIES, TYPE_LABEL } from '../ui.jsx';

export default function NewItem({ user }) {
  const qc = useQueryClient();
  const teams = user.memberships.filter((m) => m.role !== 'viewer');
  const [f, setF] = useState({ team_id: teams[0]?.team_id ?? '', title: '', description: '', type: 'task', priority: 'medium', due_date: '' });
  // One Idempotency-Key per distinct payload: retries / double submits reuse it, edits get a fresh one.
  const keyRef = useRef({ key: newKey(), payload: '' });
  const m = useMutation({
    mutationFn: () => {
      const body = { ...f, team_id: Number(f.team_id), due_date: f.due_date || null };
      const payload = JSON.stringify(body);
      if (keyRef.current.payload !== payload) keyRef.current = { key: newKey(), payload };
      return mutateApi('POST', '/items', { body, key: keyRef.current.key });
    },
    onSuccess: (item) => { qc.invalidateQueries({ queryKey: ['items'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); location.hash = `#/items/${item.id}`; },
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  if (!teams.length) return <p className="pad">You only have viewer access, so you cannot create items.</p>;
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <h2>New work item</h2>
      <label>Team<select value={f.team_id} onChange={set('team_id')}>{teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_name} ({t.role})</option>)}</select></label>
      <label>Title<input required maxLength={200} value={f.title} onChange={set('title')} /></label>
      <label>Description (why does this exist?)<textarea rows={5} value={f.description} onChange={set('description')} /></label>
      <div className="row">
        <label>Type<select value={f.type} onChange={set('type')}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Priority<select value={f.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label>Due date<input type="date" value={f.due_date} onChange={set('due_date')} /></label>
      </div>
      {m.error && <p className="error">{m.error.message}</p>}
      <button className="btn" disabled={m.isPending}>{m.isPending ? 'Creating…' : 'Create'}</button>
    </form>
  );
}
