Slack channel connector and stability release

Promotes latest main to production.

Highlights:
- Slack native channel connector consolidation and CLI parity fixes.
- DB migration backfills executor_connector_provider=channel on faked-baseline prod databases so Slack channel connector materialization works.
- Live-schema deploy gate now checks enum values, preventing this drift class from recurring.
- Includes latest main stability/dependency updates already green on main.
