#!/usr/bin/env bash
# Proves MathJax TeX -> SVG (lib/math/tex-to-svg.ts) is identical on the Hermes
# VM the app ships.
#
# 1. Bundles entry.ts (10 formulas, 2 of them invalid) with the metro.config.js
#    `#default-font/` alias.
# 2. Builds the JSI host from ../hermes-highlight-check against the macOS slice
#    of the Hermes framework in ios/Pods, and runs the bundle as source, then
#    after babel-preset-expo + `hermesc -O` as bytecode (the shipped form).
# 3. Runs the same bundle under Bun (the reference) and Node.
# 4. Compares every formula's markup, size, depth, and error. Exit 1 on any
#    difference.
#
# Needs `pod install` to have populated ios/Pods/hermes-engine. Usage:
#   scripts/hermes-math-check/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
HERMES="$APP/ios/Pods/hermes-engine/destroot"
SHARED="$APP/scripts/hermes-highlight-check"
OUT="${TMPDIR:-/tmp}/hermes-math-check"
mkdir -p "$OUT"

if [ ! -d "$HERMES/Library/Frameworks/macosx/hermesvm.framework" ]; then
  echo "Hermes macOS framework not found under $HERMES. Run pod install in ios/." >&2
  exit 2
fi

cd "$APP"
bun "$HERE/build.ts" "$OUT/bundle.js"
clang++ -std=c++20 -O2 -I"$HERMES/include" "$SHARED/host.cpp" \
  -F"$HERMES/Library/Frameworks/macosx" -framework hermesvm \
  -Wl,-rpath,"$HERMES/Library/Frameworks/macosx" -o "$OUT/hermes-host"

bun "$OUT/bundle.js" > "$OUT/bun.json"
node "$OUT/bundle.js" > "$OUT/node.json"
"$OUT/hermes-host" "$OUT/bundle.js" > "$OUT/hermes.json"
node "$SHARED/babelize.cjs" "$OUT/bundle.js" "$OUT/bundle.babel.js"
"$HERMES/bin/hermesc" -emit-binary -O -out "$OUT/bundle.hbc" "$OUT/bundle.babel.js"
"$OUT/hermes-host" "$OUT/bundle.hbc" > "$OUT/hermes-hbc.json"

bun -e '
const fs = require("fs");
const [bun, node, hermes, hbc] = process.argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
const strip = ({ ms, ...rest }) => JSON.stringify(rest);
let failures = 0;
for (const name of Object.keys(bun.formulas)) {
  const reference = strip(bun.formulas[name]);
  const same = [node, hermes, hbc].every((run) => strip(run.formulas[name] ?? {}) === reference);
  if (!same) failures++;
  const f = bun.formulas[name];
  const what = f.error ? `error "${f.error}"` : `${f.xml.length} B svg, ${f.width}x${f.height} depth ${f.depth}`;
  const ms = (o) => String(o.formulas[name]?.ms).padStart(5) + "ms";
  console.log(`${same ? "same" : "DIFF"}  ${name.padEnd(20)} ${what.padEnd(44)} bun ${ms(bun)}  hermes ${ms(hermes)}  bytecode ${ms(hbc)}`);
}
console.log(`total: bun ${bun.totalMs}ms, hermes ${hermes.totalMs}ms, hermes bytecode ${hbc.totalMs}ms (first call includes MathJax setup)`);
const total = Object.keys(bun.formulas).length;
console.log(`${total - failures}/${total} formulas: Node and Hermes (source and bytecode) output identical to Bun`);
process.exit(failures ? 1 : 0);
' "$OUT/bun.json" "$OUT/node.json" "$OUT/hermes.json" "$OUT/hermes-hbc.json"
