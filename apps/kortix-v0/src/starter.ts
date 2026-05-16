export interface StarterFile {
  path: string;
  content: string;
}

function minimalOpenCodeConfig(): string {
  return `{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false
}
`;
}

export function starterFiles(projectName: string): StarterFile[] {
  return [
    {
      path: "kortix.toml",
      content: `schema = "https://schemas.kortix.com/project/v0"
name = "${projectName}"

[runtime]
engine = "opencode"
mode = "ephemeral"
workspace = "/workspace"

[source]
default_branch = "main"

[opencode]
config_dir = ".opencode"
config = ".opencode/opencode.jsonc"

[env]
required = []
optional = []
`,
    },
    {
      path: ".opencode/opencode.jsonc",
      content: minimalOpenCodeConfig(),
    },
    {
      path: ".gitignore",
      content: `.env
.env.*
node_modules/
`,
    },
    {
      path: "README.md",
      content: `# ${projectName}

Minimal Kortix v0 project.

This repo is cloned into a session sandbox and OpenCode boots from:

\`\`\`bash
/workspace/.kortix/.opencode
\`\`\`
`,
    },
  ];
}
