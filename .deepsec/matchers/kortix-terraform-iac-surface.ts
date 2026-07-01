import type { CandidateMatch, MatcherPlugin } from "deepsec/config";

const IAC_RE = /^(?:resource|module|data|provider|terraform|variable|output)\s+["{]/;

export const kortixTerraformIacSurface: MatcherPlugin = {
  slug: "kortix-terraform-iac-surface",
  description: "Kortix Terraform/IaC files for cloud security review coverage",
  noiseTier: "noisy",
  filePatterns: ["infra/terraform/**/*.tf"],
  match(content, filePath): CandidateMatch[] {
    if (filePath.includes("/.terraform/")) return [];
    const lines = content.split("\n");
    const matches: CandidateMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!IAC_RE.test(lines[i].trim())) continue;
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 7);
      matches.push({
        vulnSlug: "kortix-terraform-iac-surface",
        lineNumbers: [i + 1],
        snippet: lines.slice(start, end).join("\n"),
        matchedPattern: "Terraform/IaC declaration requiring cloud security review",
      });
      break;
    }
    return matches;
  },
};
