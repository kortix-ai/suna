/** The value after `--name` in argv, or undefined when the flag is absent. */
export function flag(name: string, argv: readonly string[] = process.argv): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
