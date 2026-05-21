export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export function formatDateTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}
