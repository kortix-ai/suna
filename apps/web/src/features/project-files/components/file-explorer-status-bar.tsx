'use client';

import { useMemo } from 'react';
import { GitBranch, AlertTriangle, CircleAlert } from 'lucide-react';
import { useFilesStore } from '../store/files-store';
import { useGitStatus, useServerHealth, useCurrentProject } from '../hooks';
import { useDiagnosticsStore } from '@/stores/diagnostics-store';

function getLanguageLabel(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React',
    py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
    java: 'Java', c: 'C', cpp: 'C++', h: 'C Header', hpp: 'C++ Header',
    cs: 'C#', swift: 'Swift', kt: 'Kotlin', php: 'PHP',
    html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
    xml: 'XML', sql: 'SQL', sh: 'Shell', bash: 'Bash', zsh: 'Zsh',
    md: 'Markdown', mdx: 'MDX', txt: 'Plain Text',
    dockerfile: 'Dockerfile', makefile: 'Makefile',
    vue: 'Vue', svelte: 'Svelte',
    pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint',
    png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF',
    svg: 'SVG', webp: 'WebP', mp4: 'MP4', webm: 'WebM',
    mp3: 'MP3', wav: 'WAV', csv: 'CSV', tsv: 'TSV',
  };
  return map[ext] || ext.toUpperCase() || '';
}

export function FileExplorerStatusBar() {
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath);

  const { data: gitStatuses } = useGitStatus({ enabled: false });
  const { data: health } = useServerHealth();
  const { data: project } = useCurrentProject();
  const diagByFile = useDiagnosticsStore((s) => s.byFile);

  const totalChanges = gitStatuses?.length ?? 0;

  const { totalErrors, totalWarnings } = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const diags of Object.values(diagByFile)) {
      for (const d of diags) {
        if (d.severity === 1) errors++;
        else if (d.severity === 2) warnings++;
      }
    }
    return { totalErrors: errors, totalWarnings: warnings };
  }, [diagByFile]);

  const fileName = selectedFilePath?.split('/').pop() || '';
  const languageLabel = fileName ? getLanguageLabel(fileName) : '';

  return (
    <div className="flex items-center justify-between gap-4 px-3 border-t border-border/50 bg-background text-xs text-muted-foreground/70 shrink-0 h-8 select-none">
      {/* Left side */}
      <div className="flex items-center gap-3 min-w-0">
        {project?.vcs === 'git' && (
          <span className="flex items-center gap-1 shrink-0">
            <GitBranch className="h-3 w-3" />
            <span>main</span>
            {totalChanges > 0 && (
              <span className="text-yellow-500/80">+{totalChanges}</span>
            )}
          </span>
        )}

        {(totalErrors > 0 || totalWarnings > 0) && (
          <span className="flex items-center gap-2 shrink-0">
            {totalErrors > 0 && (
              <span className="flex items-center gap-0.5 text-red-500/80">
                <CircleAlert className="h-3 w-3" />
                {totalErrors}
              </span>
            )}
            {totalWarnings > 0 && (
              <span className="flex items-center gap-0.5 text-yellow-500/80">
                <AlertTriangle className="h-3 w-3" />
                {totalWarnings}
              </span>
            )}
          </span>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3 shrink-0">
        {languageLabel && (
          <span>{languageLabel}</span>
        )}
        {health?.version && (
          <span className="opacity-50">v{health.version}</span>
        )}
      </div>
    </div>
  );
}
