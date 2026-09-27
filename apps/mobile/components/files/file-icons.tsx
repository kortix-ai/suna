/**
 * FileGlyph — a file's icon by its name (`fileIconKey`), filled, in the muted
 * foreground (Jay, 2026-09-22): each web language has its own glyph, the
 * Kortix files carry the Kortix symbol, git's dotfiles the git glyph.
 */
import * as React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';

import { KortixLogo } from '@/components/kortix/KortixLogo';
import { Icon } from '@/components/ui/icon';
import { fileIconKey, type FileIconKey } from '@/lib/files/file-icon';
import {
  CertificateIcon,
  DatabaseIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCIcon,
  FileCodeIcon,
  FileCppIcon,
  FileCssIcon,
  FileCsvIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileIcon,
  FileImageIcon,
  FileIniIcon,
  FileJpgIcon,
  FileJsIcon,
  FileJsxIcon,
  FileLockIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePngIcon,
  FilePptIcon,
  FilePyIcon,
  FileRsIcon,
  FileSqlIcon,
  FileSvgIcon,
  FileTsIcon,
  FileTsxIcon,
  FileTxtIcon,
  FileVideoIcon,
  FileVueIcon,
  FileXlsIcon,
  FileZipIcon,
  GitBranchIcon,
  TerminalWindowIcon,
  type AppIcon,
} from '@/lib/icons';

const GLYPHS: Record<Exclude<FileIconKey, 'kortix'>, AppIcon> = {
  git: GitBranchIcon,
  tsx: FileTsxIcon, ts: FileTsIcon, js: FileJsIcon, jsx: FileJsxIcon,
  html: FileHtmlIcon, css: FileCssIcon, vue: FileVueIcon,
  py: FilePyIcon, rs: FileRsIcon, c: FileCIcon, cpp: FileCppIcon, sql: FileSqlIcon, code: FileCodeIcon,
  md: FileMdIcon, txt: FileTxtIcon, csv: FileCsvIcon, ini: FileIniIcon,
  png: FilePngIcon, jpg: FileJpgIcon, svg: FileSvgIcon, image: FileImageIcon, video: FileVideoIcon, audio: FileAudioIcon,
  pdf: FilePdfIcon, doc: FileDocIcon, xls: FileXlsIcon, ppt: FilePptIcon, zip: FileZipIcon, archive: FileArchiveIcon,
  lock: FileLockIcon, terminal: TerminalWindowIcon, database: DatabaseIcon, certificate: CertificateIcon, file: FileIcon,
};

export function FileGlyph({ name, size }: { name: string; size: number }) {
  const { colorScheme } = useColorScheme();
  const key = fileIconKey(name);
  // `KortixLogo`'s `color` names the SURFACE: the white symbol for a dark one.
  if (key === 'kortix') {
    // The symbol fills its box edge to edge; the Phosphor glyphs keep ~15% of
    // theirs clear, so the mark is drawn at 0.72× to sit at the same weight.
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <KortixLogo variant="symbol" size={Math.round(size * 0.72)} color={colorScheme === 'dark' ? 'dark' : 'light'} />
      </View>
    );
  }
  return <Icon as={GLYPHS[key]} size={size} weight="fill" className="text-muted-foreground" />;
}
