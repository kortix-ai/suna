/**
 * The three choices for who may open sessions a trigger creates, worded by
 * the permission the API actually checks — not by a role nickname.
 *
 * `private` is enforced in `apps/api/src/projects/lib/access.ts`
 * (`loadProjectSessionForUser`): a caller who is not a session-bound agent
 * credential reads a trigger-created private session when
 * `authorize(actor, 'project.trigger.update', project)` allows it. Account
 * owners and admins hold manager standing implicitly. So the truthful copy
 * names the permission and the roles that carry it (Marko, 2026-09-03: "if
 * it's a permission then rather state that").
 *
 * One module, imported by the create modal and the detail sheet, so the two
 * never drift — the e2e spec `21-trigger-session-access.spec.ts` pins the
 * labels below verbatim.
 */
export const TRIGGER_SESSION_ACCESS_COPY = {
  heading: 'Who can open sessions this trigger creates',
  private: {
    label: 'Trigger managers only',
    desc: "Anyone whose project role includes the project.trigger.update permission — Project admin by default — plus account owners and admins. The trigger's own agent always can.",
  },
  members: {
    label: 'Selected teammates',
    desc: 'The members and groups you pick, in addition to trigger managers.',
  },
  project: {
    label: 'Whole project',
    desc: 'Every project member.',
  },
} as const;
