Production hotfix: account membership repair

- Keep the Slack identity/session authorization release active in production.\n- Repair explicit legacy account memberships during project provisioning so fresh production users can create projects after /accounts returns a legacy account_id.\n- Preserve the normal account_members authorization gate after the repair and cover it with a managed-project provisioning regression test.\n- Verified staging API health for 0.9.84-staging.10fccfe9 and staging deploy live verification.
