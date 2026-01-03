import sentry_sdk
from sentry_sdk.integrations.dramatiq import DramatiqIntegration
import os

sentry_dsn = os.getenv("SENTRY_DSN", None)
if sentry_dsn:
  sentry_sdk.init(
      dsn=sentry_dsn,
      integrations=[DramatiqIntegration()],
      traces_sample_rate=0.1,
      send_default_pii=True,
      _experiments={
          "enable_logs": True,
      },
  )

sentry = sentry_sdk
