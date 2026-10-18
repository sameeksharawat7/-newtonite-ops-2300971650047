import { AppError } from './errors.js';
import { STATUSES } from './workflow.js';

export const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const bad = (msg) => new AppError(400, 'VALIDATION', msg);

export function toId(v, label = 'id') {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad(`${label} must be a positive integer`);
  return n;
}
const str = (v, label, { min = 1, max }) => {
  if (typeof v !== 'string') throw bad(`${label} must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${label} must be ${min}-${max} characters`);
  return s;
};
const oneOf = (v, list, label) => {
  if (!list.includes(v)) throw bad(`${label} must be one of: ${list.join(', ')}`);
  return v;
};
const date = (v) => {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad('due_date must be YYYY-MM-DD');
  return v;
};

export function validateNewItem(b = {}) {
  return {
    team_id: toId(b.team_id, 'team_id'),
    title: str(b.title, 'title', { max: 200 }),
    description: b.description == null ? '' : str(b.description, 'description', { min: 0, max: 10000 }),
    type: oneOf(b.type, TYPES, 'type'),
    priority: b.priority == null ? 'medium' : oneOf(b.priority, PRIORITIES, 'priority'),
    due_date: b.due_date == null ? null : date(b.due_date),
  };
}

export function validatePatch(b = {}) {
  const out = { version: toId(b.version, 'version'), fields: {} };
  if ('title' in b) out.fields.title = str(b.title, 'title', { max: 200 });
  if ('description' in b) out.fields.description = str(b.description, 'description', { min: 0, max: 10000 });
  if ('priority' in b) out.fields.priority = oneOf(b.priority, PRIORITIES, 'priority');
  if ('due_date' in b) out.fields.due_date = date(b.due_date);
  return out;
}

export const validateTransition = (b = {}) => ({
  to: oneOf(b.to, STATUSES, 'to'),
  version: toId(b.version, 'version'),
  comment: b.comment ? str(b.comment, 'comment', { max: 2000 }) : null,
});
export const validateAssign = (b = {}) => ({ assignee_id: toId(b.assignee_id, 'assignee_id'), version: toId(b.version, 'version') });
export const validateComment = (b = {}) => ({ body: str(b.body, 'body', { max: 5000 }) });
