import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ItemDetail from './pages/ItemDetail.jsx';
import NewItem from './pages/NewItem.jsx';
import Notifications from './pages/Notifications.jsx';

const useHash = () => {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => { const f = () => setH(location.hash || '#/'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
};

export default function App() {
  const hash = useHash();
  const qc = useQueryClient();
  const token = localStorage.getItem('token');
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('GET', '/me'), enabled: !!token });
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => api('GET', '/notifications'), enabled: !!token, refetchInterval: 15000 });

  if (!token || hash === '#/login') return <Login onLogin={() => { qc.clear(); location.hash = '#/'; }} />;
  if (me.isLoading) return <p className="pad">Loading…</p>;
  if (me.error) return <p className="pad">Could not load profile. <a href="#/login" onClick={() => localStorage.removeItem('token')}>Sign in again</a></p>;

  const user = me.data;
  const itemMatch = /^#\/items\/(\d+)$/.exec(hash);
  return (
    <>
      <header>
        <a href="#/" className="brand">Ops Desk</a>
        <a href="#/new" className="btn small">+ New item</a>
        <span className="spacer" />
        <a href="#/notifications">🔔{notes.data?.unread > 0 && <b className="badge-count">{notes.data.unread}</b>}</a>
        <span title={user.memberships.map((m) => `${m.team_name}: ${m.role}`).join('\n')}>{user.name}</span>
        <button className="link" onClick={() => { localStorage.removeItem('token'); qc.clear(); location.hash = '#/login'; }}>Sign out</button>
      </header>
      <main>
        {itemMatch ? <ItemDetail id={Number(itemMatch[1])} user={user} />
          : hash === '#/new' ? <NewItem user={user} />
          : hash === '#/notifications' ? <Notifications />
          : <Dashboard user={user} />}
      </main>
    </>
  );
}
