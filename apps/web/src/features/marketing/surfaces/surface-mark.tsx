import { MicrosoftTeams } from '@kortix/ui/internal/icons/microsoft-teams';
import { Slack } from '@kortix/ui/internal/icons/slack';
import {
  DesktopIcon,
  DeviceMobileIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react/dist/ssr';

import { AppleLogo, AppStoreLogo, GooglePlayLogo, LinuxLogo, WindowsLogo } from './os-logos';

export type MarkId =
  | 'desktop'
  | 'mobile'
  | 'cli'
  | 'slack'
  | 'teams'
  | 'apple'
  | 'windows'
  | 'linux'
  | 'appstore'
  | 'googleplay';

/** The glyph for a surface or a platform. Slack and Teams keep their own
 *  colours (they are the brands); the rest are ink, at the button's size. */
export function SurfaceMark({ id, className = 'size-4' }: { id: MarkId; className?: string }) {
  switch (id) {
    case 'desktop':
      return <DesktopIcon aria-hidden className={className} />;
    case 'mobile':
      return <DeviceMobileIcon aria-hidden className={className} />;
    case 'cli':
      return <TerminalWindowIcon aria-hidden className={className} />;
    case 'slack':
      return <Slack className={className} />;
    case 'teams':
      return <MicrosoftTeams className={className} />;
    case 'apple':
      return <AppleLogo className={className} />;
    case 'windows':
      return <WindowsLogo className={className} />;
    case 'linux':
      return <LinuxLogo className={className} />;
    case 'appstore':
      return <AppStoreLogo className={className} />;
    case 'googleplay':
      return <GooglePlayLogo className={className} />;
  }
}
