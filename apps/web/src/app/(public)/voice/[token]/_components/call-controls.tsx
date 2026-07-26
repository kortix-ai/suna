'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { IconMic, IconMicOff, IconPhoneOff } from '@/components/ui/kortix-icons';
import { cn } from '@/lib/utils';

/** Bottom control bar — real, obvious call controls, sized well past the
 *  40×40px minimum hit area and styled like the round buttons on Meet/Zoom. */
export function CallControls({
  micEnabled,
  onToggleMic,
  onLeave,
  disabled,
}: {
  micEnabled: boolean;
  onToggleMic: () => void;
  onLeave: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="border-border bg-background/95 border-t px-4 py-3 backdrop-blur-sm sm:px-6">
      <div className="mx-auto flex max-w-2xl items-center justify-center gap-4">
        <Hint label={micEnabled ? 'Mute microphone' : 'Unmute microphone'} side="top">
          <Button
            type="button"
            variant={micEnabled ? 'outline' : 'destructive'}
            size="icon-lg"
            disabled={disabled}
            onClick={onToggleMic}
            aria-label={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
            aria-pressed={!micEnabled}
            className={cn('size-12 rounded-full active:scale-[0.96]')}
          >
            {micEnabled ? <IconMic className="size-5" /> : <IconMicOff className="size-5" />}
          </Button>
        </Hint>
        <Hint label="Leave call" side="top">
          <Button
            type="button"
            variant="danger"
            size="icon-lg"
            disabled={disabled}
            onClick={onLeave}
            aria-label="Leave call"
            className="size-12 rounded-full active:scale-[0.96]"
          >
            <IconPhoneOff className="size-5" />
          </Button>
        </Hint>
      </div>
    </div>
  );
}
