/** Minimal colored logger. */
const useColor = process.stdout.isTTY && process.env.NO_COLOR == null;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const log = {
  info: (m: string) => console.log(m),
  step: (m: string) => console.log(c("90", `  · ${m}`)),
  pass: (m: string) => console.log(`${c("32", "✓")} ${m}`),
  fail: (m: string) => console.log(`${c("31", "✗")} ${m}`),
  skip: (m: string) => console.log(`${c("33", "○")} ${m}`),
  warn: (m: string) => console.warn(c("33", `! ${m}`)),
  error: (m: string) => console.error(c("31", m)),
  dim: (m: string) => c("90", m),
  bold: (m: string) => c("1", m),
};
