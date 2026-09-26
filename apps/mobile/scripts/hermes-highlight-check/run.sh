#!/usr/bin/env bash
# Proves the Shiki JavaScript regex engine works on the Hermes VM the app ships.
#
# 1. Bundles entry.ts (the app's lib/highlight/shiki.ts, strict engine, every
#    bundled grammar) into one script.
# 2. Builds a 30-line JSI host against the macOS slice of the Hermes framework
#    in ios/Pods (the same Hermes build as the iOS app) and runs the bundle.
#    It runs twice: as source, and after babel-preset-expo (babelize.cjs) +
#    `hermesc -O` as bytecode, the form a production build ships.
# 3. Runs the same bundle under Bun (V8-class engine) for timing comparison.
# 4. Prints Oniguruma (WebAssembly, the engine web runs) reference tokens.
# 5. Compares Hermes against Oniguruma, colour run by colour run, per grammar
#    and theme, and prints timings. Exit 1 on any difference.
#
# Needs `pod install` to have populated ios/Pods/hermes-engine. Usage:
#   scripts/hermes-highlight-check/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
HERMES="$APP/ios/Pods/hermes-engine/destroot"
OUT="${TMPDIR:-/tmp}/hermes-highlight-check"
mkdir -p "$OUT"

if [ ! -d "$HERMES/Library/Frameworks/macosx/hermesvm.framework" ]; then
  echo "Hermes macOS framework not found under $HERMES. Run pod install in ios/." >&2
  exit 2
fi

cd "$APP"
bun build "$HERE/entry.ts" --target=browser --format=iife --outfile "$OUT/bundle.js" >/dev/null
clang++ -std=c++20 -O2 -I"$HERMES/include" "$HERE/host.cpp" \
  -F"$HERMES/Library/Frameworks/macosx" -framework hermesvm \
  -Wl,-rpath,"$HERMES/Library/Frameworks/macosx" -o "$OUT/hermes-host"

bun "$OUT/bundle.js" > "$OUT/bun.json"
"$OUT/hermes-host" "$OUT/bundle.js" > "$OUT/hermes.json"
node "$HERE/babelize.cjs" "$OUT/bundle.js" "$OUT/bundle.babel.js"
"$HERMES/bin/hermesc" -emit-binary -O -out "$OUT/bundle.hbc" "$OUT/bundle.babel.js"
"$OUT/hermes-host" "$OUT/bundle.hbc" > "$OUT/hermes-hbc.json"
bun "$HERE/reference.ts" > "$OUT/oniguruma.json"

bun -e '
const fs = require("fs");
const [bun, hermes, hbc, onig] = process.argv.slice(1).map((p) => {
  const text = fs.readFileSync(p, "utf8").trim();
  if (text.startsWith("FAILED")) { console.error(p, text); process.exit(1); }
  return JSON.parse(text);
});
// One string per colour run, so differently split but identically painted tokens compare equal.
const paint = (lines) => JSON.stringify((lines ?? []).map((line) => {
  const out = []; let color = ""; let run = "";
  for (const t of line) for (const ch of t.content) {
    const c = t.color.toLowerCase();
    if (c !== color && run) { out.push(color + ":" + run); run = ""; }
    color = c; run += ch;
  }
  if (run) out.push(color + ":" + run);
  return out.join("|");
}));
let failures = 0;
for (const lang of Object.keys(onig.langs)) {
  const same = ["light", "dark"].every((s) =>
    paint(hermes.langs[lang]?.tokens[s]) === paint(onig.langs[lang].tokens[s]) &&
    paint(hbc.langs[lang]?.tokens[s]) === paint(onig.langs[lang].tokens[s]));
  if (!same) failures++;
  const ms = (o) => String(o.langs[lang].loadMs).padStart(4) + "ms";
  console.log(`${same ? "same" : "DIFF"}  ${lang.padEnd(11)} grammar load: bun ${ms(bun)}  hermes ${ms(hermes)}  hermes bytecode ${ms(hbc)}`);
}
console.log(`highlighter init: bun ${bun.initMs}ms, hermes ${hermes.initMs}ms`);
console.log(`typescript at the ceiling (${bun.large.chars} chars, ${bun.large.lines} lines), one synchronous pass: bun ${bun.large.ms}ms, hermes ${hermes.large.ms}ms, hermes bytecode ${hbc.large.ms}ms`);
const total = Object.keys(onig.langs).length;
console.log(`${total - failures}/${total} grammars: Hermes (source and bytecode) output identical to Oniguruma in light and dark`);
process.exit(failures ? 1 : 0);
' "$OUT/bun.json" "$OUT/hermes.json" "$OUT/hermes-hbc.json" "$OUT/oniguruma.json"
