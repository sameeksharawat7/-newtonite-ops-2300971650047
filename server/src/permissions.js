import { AppError } from './errors.js';

// Role x action matrix. Rank order: viewer < member < lead < admin.
const RANK = { viewer: 1, member: 2, lead: 3, admin: 4 };
const MIN_ROLE = {
  read: 'viewer',
  create: 'member',
  comment: 'member',
  claim: 'member',
  edit: 'member',
  transition: 'member',
  assign: 'lead',
  approve: 'lead',
  close: 'lead',
};

export const roleFor = (user, teamId) =>
  user.memberships.find((m) => m.team_id === teamId)?.role ?? null;

/**
 * THE permission function. Every endpoint goes through this (via authorize()).
 * `item` needs { team_id, assignee_id } so rules can be resource-level.
 * Non-members get 404 (we do not reveal that the item exists), insufficient role gets 403.
 */
export function check(user, action, item) {
  const role = roleFor(user, item.team_id);
  if (!role) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Not found' };
  if (RANK[role] < RANK[MIN_ROLE[action]]) {
    return { ok: false, status: 403, code: 'INSUFFICIENT_ROLE', message: `Your role (${role}) cannot ${action} in this team` };
  }
  const privileged = RANK[role] >= RANK.lead;
  if (action === 'edit' && !privileged && item.assignee_id && item.assignee_id !== user.id) {
    return { ok: false, status: 403, code: 'NOT_OWNER', message: 'Only the assignee or a lead can edit an assigned item' };
  }
  if (action === 'transition' && !privileged && item.assignee_id !== user.id) {
    return { ok: false, status: 403, code: 'NOT_OWNER', message: 'Only the assignee or a lead can move this item' };
  }
  if (action === 'approve' && item.assignee_id === user.id) {
    return { ok: false, status: 403, code: 'SELF_APPROVAL', message: 'You cannot approve work assigned to you (four-eyes rule)' };
  }
  return { ok: true };
}

export function authorize(user, action, item) {
  const r = check(user, action, item);
  if (!r.ok) throw new AppError(r.status, r.code, r.message);
}
