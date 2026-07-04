/**
 * Files store — single shared instance.
 *
 * The store definition lives in `features/project-files/store/files-store`
 * (the module that owns the shared Drive explorer UI). This re-export keeps
 * the long-standing `@/features/files` import path working and — critically —
 * keeps store identity single: the session explorer, the kortix-computer
 * store and the file tabs all talk to the same provider/global instance.
 */
export * from '@/features/project-files/store/files-store';
