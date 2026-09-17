-- Migration: split_managed_github_app_into_identity_and_backend
--
-- EXPAND ONLY. Copies the single legacy `managed_github_app` row into the two
-- rows that replace it, and leaves the legacy row in place.
--
--   github_app_identity  — appId, privateKey, clientId, clientSecret,
--                          webhookSecret, stateSecret, slug (the App this
--                          deployment signs as).
--   managed_git_backend  — {kind:'pat', token, owner} when the legacy row
--                          carried a PAT, else {kind:'app', owner, ownerType,
--                          installationId}.
--
-- Why one row became two: every accessor read the legacy row field by field,
-- DB-first with an env fallback, so ONE stored row could shadow six env values
-- at once. That took production down on 2026-09-16 (appId 3812697 -> 4968692,
-- owner managed-kortix -> kortix-ai, token still the env PAT; all 39 account
-- installations 404ed). See .claude/skills/learnings/SKILL.md, "Never render an
-- instance-global config surface inside an account-scoped page".
--
-- CONTRACT (`delete from kortix.platform_settings where key =
-- 'managed_github_app'`) is DELIBERATELY NOT in this file. Migrations apply
-- BEFORE the new image rolls, so deleting the legacy key here would strip the
-- stored configuration from every old pod for the length of the rollout — the
-- expand/contract rule in .claude/skills/learnings/SKILL.md ("Rewiring writers
-- and converting their table to a view must be TWO releases"). The application
-- code in THIS release already reads only the two new keys, so the legacy row
-- is inert from the moment the rollout completes. The contract migration ships
-- in the release AFTER the one carrying this file; its exact SQL is in
-- docs/runbooks/managed-git-config.md.

set lock_timeout = '2s';
set statement_timeout = '30s';

-- backfill-safe: kortix.platform_settings, AT MOST 1 source row (the
-- `managed_github_app` key is a singleton by primary key) producing at most 2
-- rows. No DDL in this file, so nothing holds ACCESS EXCLUSIVE; the write is a
-- single-row upsert on a primary key and no writer can queue behind it for a
-- measurable time. This is the shape the 2026-08-10 rule exists to separate
-- from a 30M-row rewrite.

insert into kortix.platform_settings (key, value, updated_at)
select
  'github_app_identity',
  jsonb_strip_nulls(
    jsonb_build_object(
      'appId', legacy.value ->> 'appId',
      'privateKey', legacy.value ->> 'privateKey',
      'clientId', legacy.value ->> 'clientId',
      'clientSecret', legacy.value ->> 'clientSecret',
      'webhookSecret', legacy.value ->> 'webhookSecret',
      'stateSecret', legacy.value ->> 'stateSecret',
      'slug', legacy.value ->> 'slug'
    )
  ),
  now()
from kortix.platform_settings legacy
where legacy.key = 'managed_github_app'
  and coalesce(legacy.value ->> 'appId', '') <> ''
  and coalesce(legacy.value ->> 'privateKey', '') <> ''
on conflict (key) do nothing;

insert into kortix.platform_settings (key, value, updated_at)
select
  'managed_git_backend',
  case
    when coalesce(legacy.value ->> 'pat', '') <> ''
      then jsonb_build_object(
        'kind', 'pat',
        'token', legacy.value ->> 'pat',
        'owner', coalesce(nullif(legacy.value ->> 'patOwner', ''), legacy.value ->> 'owner')
      )
    else jsonb_strip_nulls(
      jsonb_build_object(
        'kind', 'app',
        'owner', legacy.value ->> 'owner',
        'ownerType', legacy.value ->> 'ownerType',
        'installationId', legacy.value ->> 'installationId'
      )
    )
  end,
  now()
from kortix.platform_settings legacy
where legacy.key = 'managed_github_app'
  -- A token backend needs a token and an owner; an App backend needs an owner
  -- and an installation id. A row that satisfies neither is skipped whole —
  -- the resolvers refuse a partial configuration anyway, so copying one would
  -- only move a broken state forward. An empty `{}` row (the 2026-09-16
  -- recovery value) satisfies neither and is skipped.
  and (
    (
      coalesce(legacy.value ->> 'pat', '') <> ''
      and coalesce(nullif(legacy.value ->> 'patOwner', ''), legacy.value ->> 'owner', '') <> ''
    )
    or (
      coalesce(legacy.value ->> 'pat', '') = ''
      and coalesce(legacy.value ->> 'owner', '') <> ''
      and coalesce(legacy.value ->> 'installationId', '') <> ''
    )
  )
on conflict (key) do nothing;
