import React, { useState } from 'react';
import { api } from '../api.js';

const DEMO = [
  ['admin@demo.test', 'Admin (all teams)'], ['lead1@demo.test', 'Lead (Eng, Payments)'], ['lead2@demo.test', 'Lead (Support, Compliance)'],
  ['member1@demo.test', 'Member (Eng, Support)'], ['member3@demo.test', 'Member (Payments)'], ['viewer@demo.test', 'Viewer (read-only)'],
];

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('member1@demo.test');
  const [password, setPassword] = useState('password123');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const { token } = await api('POST', '/auth/login', { body: { email, password } }); localStorage.setItem('token', token); onLogin(); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <form className="card login" onSubmit={submit}>
      <h2>Ops Desk</h2>
      <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {err && <p className="error">{err}</p>}
      <button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="muted">Demo users (password <code>password123</code>):</p>
      <ul className="demo">{DEMO.map(([e, l]) => <li key={e}><button type="button" className="link" onClick={() => setEmail(e)}>{e}</button> — {l}</li>)}</ul>
    </form>
  );
}
