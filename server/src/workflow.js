// Single source of truth for the workflow state machine.
// Each edge says which permission action is needed to take it.
// "open" has no outgoing edges: an item leaves "open" only via claim / assign,
// which also set the owner (the DB CHECK requires an owner for in_progress).
export const STATUSES = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];

export const TRANSITIONS = {
  open: {},
  in_progress: {
    awaiting_approval: { action: 'transition' },
    open: { action: 'transition', clearAssignee: true }, // "release" back to the pool
  },
  awaiting_approval: {
    resolved: { action: 'approve' },     // approval step: lead/admin, never the assignee
    in_progress: { action: 'approve' },  // rejection
  },
  resolved: {
    closed: { action: 'close' },
    in_progress: { action: 'transition' }, // reopen
  },
  closed: {},
};
