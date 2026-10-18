// All HTTP lives here. Components never call fetch directly.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || 'Request failed');
    this.status = status;
    this.code = body?.error?.code;
    this.current = body?.error?.current; // latest server copy on 409 conflicts
  }
}

export const newKey = () =>
  (globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);

async function once(method, path, { body, key } = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(key && { 'Idempotency-Key': key }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') { localStorage.removeItem('token'); location.hash = '#/login'; }
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = (method, path, opts) => once(method, path, opts);

/**
 * Mutations: a network failure (not an HTTP error) is retried with the SAME Idempotency-Key,
 * so "did my request go through?" can never create a duplicate.
 */
export async function mutateApi(method, path, { body, key = newKey() } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await once(method, path, { body, key }); }
    catch (e) { if (e instanceof ApiError) throw e; lastErr = e; await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); }
  }
  throw new Error('Network problem — please check your connection and try again.');
}

export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
