import { Button } from '@/components/ui/button';

interface VersionBannerProps {
  versionDate?: string;
  onReturnToCurrent: () => void;
}

export function VersionBanner({ versionDate, onReturnToCurrent }: VersionBannerProps) {
  return (
    <div className="px-4 py-2 bg-muted/50 border-b border-border flex items-center justify-between">
      <div className="flex items-center gap-2">
        <svg className="h-4 w-4 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="text-sm text-foreground">
          Viewing version from {versionDate 
            ? new Date(versionDate).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              })
            : 'previous snapshot'}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onReturnToCurrent}
        className="h-7 px-2 gap-1.5 text-xs hover:bg-muted"
      >
        <svg className="h-3 w-3 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        Return to Current
      </Button>
    </div>
  );
}

