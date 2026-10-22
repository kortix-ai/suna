// The repo test runner sets AGENT_TUNNEL_HOME for every lane (tests/bin/local.ts)
// so ke2e flows never read a person's real tunnel state. These tests give each
// case its own HOME and expect ~/.agent-tunnel under it, so the override must
// not reach them or the CLI processes they spawn.
delete process.env.AGENT_TUNNEL_HOME;
