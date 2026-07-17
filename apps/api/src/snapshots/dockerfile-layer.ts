/**
 * Re-export shim. The layer renderer moved to `@kortix/shared/sandbox` so the
 * CLI can render it too; this keeps every existing `./dockerfile-layer` import
 * inside apps/api working unchanged.
 */

export * from '@kortix/shared/sandbox';
