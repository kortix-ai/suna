Fix sandbox template snapshot builds

- Stage scaffold.git for Daytona snapshot build contexts so template builds no longer fail before user Dockerfile steps.
- Reuse the shared snapshot build-context path across providers to keep required files consistent.
