// The golden v3 manifest: the project registers skills, tools, commands and
// extensions; each agent enables them by name. Every later case edits one line.
export const GOLDEN_V3 = `
kortix_version: 3
default_agent: assistant

project:
  name: acme
  description: Support automation

env:
  required: [HELPDESK_TOKEN]

skills:
  pdf: skills/pdf
  triage-rules: support/skills/triage-rules

tools:
  lookup_order: tools/lookup_order.ts

commands:
  weekly-report:
    description: Write the weekly support report.
    prompt_file: support/commands/weekly-report.md
  summarize:
    prompt: Summarize $ARGUMENTS in five bullets.

extensions:
  audit:
    pi: extensions/audit.pi.ts
  web-access:
    pi: npm:pi-web-access@0.30.0
  mcp-adapter:
    pi:
      source: npm:pi-mcp-adapter@2.36.0
      extensions: ["extensions/*.ts"]

agents:
  assistant:
    description: The project's main agent.
    mode: primary
    model: kortix/glm-5.3-flash
    prompt_file: agents/assistant.md
    permission:
      bash:
        "*": allow
        "git push *": ask
      external_directory: deny
    tools: all
    skills: all
    subagents: [researcher]
    commands: [weekly-report, summarize]
    extensions: [audit, web-access]
    codemode: on
    connectors: all
    secrets: [HELPDESK_TOKEN]
    kortix_permissions: [project.session.start]
  researcher:
    description: Looks up an account's history.
    mode: subagent
    prompt: You research accounts. Never edit files.
    permission:
      edit: deny
    tools:
      exclude: [lookup_order]
    skills: [triage-rules, kortix-system]

triggers:
  - slug: weekly
    type: cron
    agent: assistant
    cron: "0 0 15 * * 1"
    prompt: Write the weekly support report for the last 7 days.
`;
