import React, { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, mutateApi, newKey } from '../api.js';
import { Status, Priority, ago, isOverdue, STATUS_LABEL, TYPE_LABEL, PRIORITIES } from '../ui.jsx';

const ACTION_LABEL = {
  awaiting_approval: 'Submit for approval', open: 'Release to pool', resolved: 'Approve → Resolved',
  in_progress: 'Send back / Reopen', closed: 'Close',
};

function describe(e) {
  const d = e.data;
  switch (e.type) {
    case 'created': return `created this ${d.type?.replace('_', ' ')} (${d.priority})`;
    case 'claimed': return 'claimed this item';
    case 'assigned': return `assigned it to ${d.to?.name}${d.from ? ` (was ${d.from.name})` : ''}`;
    case 'status_changed': return `moved ${STATUS_LABEL[d.from]} → ${STATUS_LABEL[d.to]}${d.comment ? ` — “${d.comment}”` : ''}`;
    case 'priority_changed': return `changed priority ${d.from} → ${d.to}`;
    case 'updated': return `edited ${Object.entries(d.changes).map(([k, c]) => `${k} (“${String(c.from ?? '')}” → “${String(c.to ?? '')}”)`).join(', ')}`;
    case 'comment': return null;
    default: return e.type;
  }
}

export default function ItemDetail({ id, user }) {
  const qc = useQueryClient();
  const key = ['item', id];
  const [msg, setMsg] = useState(null);
  const [note, setNote] = useState('');
  const [edit, setEdit] = useState(null);       // { draft, base } while editing
  const [conflict, setConflict] = useState(null); // latest server copy when our edit lost a race
  const [comment, setComment] = useState('');
  const [assignee, setAssignee] = useState('');

  const q = useQuery({ queryKey: key, queryFn: () => api('GET', `/items/${id}`), refetchInterval: 10000 });
  const item = q.data;
  const members = useQuery({
    queryKey: ['members', item?.team_id], enabled: !!item?.permissions.assign,
    queryFn: () => api('GET', `/teams/${item.team_id}/members`),
  });
  const activity = useInfiniteQuery({
    queryKey: ['activity', id], initialPageParam: null, refetchInterval: 10000,
    queryFn: ({ pageParam }) => api('GET', `/items/${id}/activity${pageParam ? `?cursor=${pageParam}` : ''}`),
    getNextPageParam: (l) => l.next_cursor,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['activity', id] });
    qc.invalidateQueries({ queryKey: ['items'] }); qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  // One mutation hook for every item action. `optimistic` paints the expected result immediately;
  // if the server rejects (409/403/...) we roll back and show the server's reason.
  const act = useMutation({
    mutationFn: ({ method, path, body }) => mutateApi(method, path, { body, key: newKey() }),
    onMutate: async (v) => {
      if (!v.optimistic) return {};
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, v.optimistic(prev));
      return { prev };
    },
    onError: (err, v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);          // roll back optimistic state
      if (err.current) qc.setQueryData(key, err.current);       // adopt the server's truth
      setMsg({ text: err.status === 409 ? `${err.message}. We loaded the latest version — please review and retry.` : err.message });
    },
    onSuccess: (data) => { setMsg(null); if (data?.version) qc.setQueryData(key, data); },
    onSettled: refresh,
  });

  const save = useMutation({
    mutationFn: () => mutateApi('PATCH', `/items/${id}`, { body: { ...edit.draft, version: edit.base }, key: newKey() }),
    onSuccess: (data) => { qc.setQueryData(key, data); setEdit(null); setConflict(null); setMsg(null); refresh(); },
    onError: (err) => { if (err.status === 409 && err.current) setConflict(err.current); else setMsg({ text: err.message }); },
  });

  const post = useMutation({
    mutationFn: ({ body, k }) => mutateApi('POST', `/items/${id}/comments`, { body: { body }, key: k }),
    onSuccess: () => { setComment(''); qc.invalidateQueries({ queryKey: ['activity', id] }); },
  });
  const [commentKey, setCommentKey] = useState(newKey());

  if (q.isLoading) return <p className="pad">Loading…</p>;
  if (q.error) return <p className="pad error">{q.status === 'error' && q.error.status === 404 ? 'This item does not exist or you do not have access.' : q.error.message}</p>;
  const p = item.permissions;
  const busy = act.isPending;

  const startEdit = (from = item) => setEdit({ base: from.version, draft: { title: from.title, description: from.description, priority: from.priority, due_date: from.due_date ?? '' } });
  const setD = (k) => (e) => setEdit({ ...edit, draft: { ...edit.draft, [k]: e.target.value } });

  return (
    <div className="detail">
      <div className="main">
        <a href="#/">← Back</a>
        {msg && <div className="banner error">{msg.text} <button className="link" onClick={() => setMsg(null)}>dismiss</button></div>}

        {!edit ? (
          <>
            <h2>#{item.id} {item.title}</h2>
            <p className="pre">{item.description || <i className="muted">No description.</i>}</p>
            {p.edit && <button className="btn small" onClick={() => startEdit()}>Edit</button>}
          </>
        ) : (
          <div className="card">
            {conflict && (
              <div className="banner error">
                Someone changed this item (now v{conflict.version}) while you were editing. Your changes were NOT saved.
                <button className="link" onClick={() => { startEdit(conflict); setConflict(null); }}>Load latest into the form</button>
                <button className="link" onClick={() => { setEdit({ ...edit, base: conflict.version }); setConflict(null); }}>Keep my draft & overwrite</button>
              </div>)}
            <label>Title<input value={edit.draft.title} onChange={setD('title')} /></label>
            <label>Description<textarea rows={5} value={edit.draft.description} onChange={setD('description')} /></label>
            <div className="row">
              <label>Priority<select value={edit.draft.priority} onChange={setD('priority')}>{PRIORITIES.map((x) => <option key={x}>{x}</option>)}</select></label>
              <label>Due date<input type="date" value={edit.draft.due_date} onChange={setD('due_date')} /></label>
            </div>
            <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
            <button className="btn ghost" onClick={() => { setEdit(null); setConflict(null); }}>Cancel</button>
          </div>
        )}

        <h3>Activity</h3>
        {p.comment && (
          <div className="comment-box">
            <textarea rows={2} placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button className="btn small" disabled={!comment.trim() || post.isPending}
              onClick={() => post.mutate({ body: comment, k: commentKey }, { onSuccess: () => setCommentKey(newKey()) })}>Comment</button>
          </div>)}
        {post.error && <p className="error">{post.error.message}</p>}
        <ul className="timeline">
          {activity.data?.pages.flatMap((pg) => pg.events).map((e) => (
            <li key={e.id} className={e.type === 'comment' ? 'comment' : ''}>
              <b>{e.actor_name ?? 'System'}</b> {e.type === 'comment' ? <span className="pre">{e.data.body}</span> : describe(e)}
              <span className="muted small"> · {ago(e.created_at)}</span>
            </li>))}
        </ul>
        {activity.hasNextPage && <button className="btn ghost small" onClick={() => activity.fetchNextPage()}>Older activity</button>}
      </div>

      <aside className="side card">
        <div><Status s={item.status} /> <Priority p={item.priority} /></div>
        <dl>
          <dt>Team</dt><dd>{item.team_name}</dd>
          <dt>Type</dt><dd>{TYPE_LABEL[item.type]}</dd>
          <dt>Owner</dt><dd>{item.assignee_name ?? <i className="muted">unassigned</i>}</dd>
          <dt>Created by</dt><dd>{item.created_by_name}</dd>
          <dt>Due</dt><dd className={isOverdue(item) ? 'error' : ''}>{item.due_date ?? '—'}</dd>
          <dt>Version</dt><dd>v{item.version}</dd>
        </dl>

        {p.claim && (
          <button className="btn" disabled={busy}
            onClick={() => act.mutate({
              method: 'POST', path: `/items/${id}/claim`,
              optimistic: (cur) => ({ ...cur, assignee_id: user.id, assignee_name: user.name, status: 'in_progress', version: cur.version + 1, permissions: { ...cur.permissions, claim: false } }),
            })}>
            Claim this item
          </button>)}

        {p.transitions.length > 0 && (
          <>
            <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            {p.transitions.map((to) => (
              <button key={to} className={`btn ${to === 'in_progress' || to === 'open' ? 'ghost' : ''}`} disabled={busy}
                onClick={() => { act.mutate({ method: 'POST', path: `/items/${id}/transition`, body: { to, version: item.version, comment: note || undefined } }); setNote(''); }}>
                {ACTION_LABEL[to] ?? to}{item.status === 'awaiting_approval' && to === 'in_progress' ? ' (reject)' : ''}
              </button>))}
          </>)}

        {p.assign && members.data && (
          <div className="assign">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Assign to…</option>
              {members.data.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
            </select>
            <button className="btn small" disabled={!assignee || busy}
              onClick={() => act.mutate({ method: 'POST', path: `/items/${id}/assign`, body: { assignee_id: Number(assignee), version: item.version } })}>Assign</button>
          </div>)}
        {!p.edit && !p.claim && !p.transitions.length && !p.assign && <p className="muted small">You have read-only access to this item right now.</p>}
      </aside>
    </div>
  );
}
