# {{projectName}}

This project runs the OpenCode runtime. `kortix.yaml` declares
`kortix_version: 2`, the current manifest schema.

## Authentication

The runtime uses Kortix-managed models or project provider credentials. Use the
project Models view to connect credentials. Do not commit credentials.

## Verify the project

1. Create a session with the `kortix` agent.
2. Send a real prompt.
3. Confirm that the response completes.

A provider availability check does not prove prompt execution. Test the exact
model that the project will use.

Run `kortix system-skills get kortix-system --full` for the current platform
instructions. Run `kortix schema --version 2` for the exact manifest schema.
