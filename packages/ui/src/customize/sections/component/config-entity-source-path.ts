export function configEntitySourcePath(path: string): string {
  return path.split('#', 1)[0] ?? path;
}
