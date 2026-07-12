import { chalkColors } from '@kortix/shared';

interface DriveFolderIconProps {
  /** Folder name — drives a stable per-folder color via chalkColors. */
  label: string;
  className?: string;
}

/**
 * Google-Drive-style filled folder glyph. Two-tone: a darker back panel + tab
 * and a lighter front pocket, tinted to a stable color derived from the folder
 * name so each folder keeps the same hue across sessions.
 */
export function DriveFolderIcon({ label, className }: DriveFolderIconProps) {
  const chalk = chalkColors(label);
  const front = chalk.border;
  const back = `color-mix(in srgb, ${chalk.border}, #000 16%)`;

  return (
    <svg
      viewBox="0 0 48 40"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* Back panel + tab */}
      <path
        d="M4 12a4 4 0 0 1 4-4h9.5a3 3 0 0 1 2.4 1.2l1.8 2.4a3 3 0 0 0 2.4 1.2H40a4 4 0 0 1 4 4V32a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V12Z"
        fill={back}
      />
      {/* Front pocket */}
      <path d="M4 16h40v16a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V16Z" fill={front} />
    </svg>
  );
}
