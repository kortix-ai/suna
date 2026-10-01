An agent permission fix, refresh-token replay protection, prompt authorship, and agents that can ask people (behind a flag).

An agent permission fix, refresh-token replay protection, prompt authorship, and agents that can ask people (behind a flag).

## New

- Every prompt records who wrote it, and the transcript shows the author.
- Agents can ask a person a question or start a group conversation with people, behind the `human_messaging` project flag (off by default).

## Security

- An agent whose policy denies `bash` or `edit` can no longer open a shell through the terminal tools or write files through the memory tool.
- A refresh token cannot be replayed, and logging out revokes the session.

## Fixed

- Chat stays available while a connector waits for approval.
- The advanced panel preference keeps the panels you open.
- The cost explorer shows a loading state until usage arrives.
- Mobile renders model reasoning as a thinking row.
- Deleting an account no longer reports its sandboxes as lost work.
- A conversation with people is named at a word boundary.

