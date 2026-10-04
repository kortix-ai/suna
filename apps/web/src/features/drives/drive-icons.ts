import { BuildingsIcon, HardDriveIcon, type Icon, RobotIcon } from '@phosphor-icons/react';

import type { DriveKind } from './drive-model';

export const DRIVE_KIND_ICON: Record<DriveKind, Icon> = {
  personal: HardDriveIcon,
  company: BuildingsIcon,
  agent: RobotIcon,
};
