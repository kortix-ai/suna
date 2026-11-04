#!/usr/bin/env bash
# Regenerate github-ipv4-ranges.json from https://api.github.com/meta: the
# IPv4 ranges of GitHub's API, git and web hosts, which the egress subnets
# route through the NAT (main.tf, "Egress subnets"). Terraform reads the
# committed file, so a plan never depends on GitHub's unauthenticated rate
# limit (60 requests an hour per IP). The weekly `github-ranges-refresh`
# workflow runs this script.
#
#   GH_TOKEN=<token> infra/terraform/modules/network/scripts/refresh-github-ranges.sh
set -euo pipefail

out="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/github-ipv4-ranges.json"
auth=()
[ -n "${GH_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${GH_TOKEN}")
meta="$(curl -fsS "${auth[@]}" -H 'Accept: application/vnd.github+json' https://api.github.com/meta)"

printf '%s' "$meta" | python3 -c '
import ipaddress, json, sys
meta = json.load(sys.stdin)
cidrs = sorted(
    {c for key in ("api", "git", "web") for c in meta[key] if ":" not in c},
    key=lambda c: ipaddress.ip_network(c),
)
if not 20 <= len(cidrs) <= 150:
    sys.exit(f"api.github.com/meta returned {len(cidrs)} IPv4 ranges; expected 20 to 150")
json.dump({"source": "https://api.github.com/meta (api, git, web; IPv4)", "cidrs": cidrs}, sys.stdout, indent=2)
print()
' >"$out.tmp"
mv "$out.tmp" "$out"
echo "wrote $(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["cidrs"]))' "$out") ranges to $out"
