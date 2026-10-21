/**
 * The size of the round icon buttons in a page's header row: the hamburger
 * (`MenuButton`), Go back (`BackButton`), the thread's `···`
 * (`ProjectHeaderActions`), the project home bell (`NotificationsButton`) and
 * `PageHeader`'s right column.
 *
 * iOS: 44pt box, 22pt icon (Jay, 2026-10-20: the 40pt circles read small next
 * to the system's own 44pt bar buttons). Android: 40pt box, 20pt icon, as
 * before.
 */
import { Platform } from 'react-native';

const IOS = Platform.OS === 'ios';

/** `Button` `size` for a header icon button. */
export const HEADER_BUTTON_SIZE = IOS ? 'icon-lg' : 'icon';
/** The same box in points (layout maths: `FloatingMenuButton`'s clearance). */
export const HEADER_BUTTON_PT = IOS ? 44 : 40;
/** The glyph inside it. */
export const HEADER_ICON_SIZE = IOS ? 22 : 20;
