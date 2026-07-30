# {{projectName}}

This project runs OpenCode through its REST API.

## Authentication

OpenCode can use Kortix-managed models or project provider credentials.

## Verify the project

## Test the runtime

1. Create a session.
2. Send a real prompt.
3. Confirm that the response completes.

A provider availability check does not prove prompt execution. Test the model
that the project will use.

Run `kortix system-skills get kortix-system --full` for the current platform
instructions. Run `kortix schema --version 2` for the exact manifest schema.
