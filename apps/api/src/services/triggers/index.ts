/**
 * Kortix trigger DSL — lives inside the project manifest (kortix.yaml; a
 * legacy v1 project may instead use kortix.toml) as a `triggers:` list of
 * entries. The manifest at the repo root is THE source of truth for
 * trigger config; runtime state (last_fired_at, executions) stays in the
 * `project_trigger_runtime` DB table.
 *
 * Example shape (kortix.yaml):
 *
 *   kortix_version: 2
 *
 *   project:
 *     name: example
 *
 *   triggers:
 *     - slug: daily-digest
 *       name: Daily digest
 *       type: cron
 *       agent: default
 *       enabled: true
 *       cron: "0 0 9 * * 1-5"
 *       timezone: UTC
 *       prompt: "Generate the daily digest…"
 *
 *     - slug: slack
 *       type: webhook
 *       secret_env: WEBHOOK_SLACK_SECRET
 *       prompt: "New {{ message.text }}"
 *
 * One file, one PR-review surface. Web-UI edits are read-modify-write on
 * this same file — see writeManifestTriggers / deleteManifestTrigger in
 * apps/api/src/projects/index.ts.
 */

export * from './trigger-types';
export * from '../../projects/manifest-io';
export * from './trigger-entry';
