// Shared access-control primitives. Every access surface — the account hub
// tabs, the group and member detail pages, the project access panel, the
// identity and audit cards — imports its picker, role select, list row,
// grant/edit modal, project select, detail shell and copy from here.
//
// Nothing under `components/iam/*` or `app/(app)/accounts/**` may define
// its own.

export * from './access-detail-shell';
export * from './access-dialog';
export * from './access-row';
export * from './access-shared';
export * from './copy-row';
export * from './principal-picker';
export * from './project-select';
export * from './role-select';
