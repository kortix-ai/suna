export const SKILL_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export function formatSkillImportFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision).replace(/\.0$/, '')} ${unit}`;
}

export function isAcceptedSkillImportFile(file: File): boolean {
  return /(^SKILL\.md$|\.md$|\.(skill|zip)$)/i.test(file.name);
}

export function skillImportFileError(file: File): string | null {
  if (!isAcceptedSkillImportFile(file)) {
    return 'Choose a SKILL.md, .md, .skill, or ZIP file.';
  }
  if (file.size > SKILL_IMPORT_MAX_BYTES) {
    return 'Skill uploads must be 10 MB or smaller.';
  }
  return null;
}
