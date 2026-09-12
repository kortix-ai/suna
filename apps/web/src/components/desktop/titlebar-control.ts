/**
 * Placement of a control the app draws in the desktop title-bar band.
 *
 * Every number comes from the band variables in globals.css, which mirror
 * apps/desktop-electron/src/window-chrome.js — the table that positions the
 * macOS traffic lights. The variables also carry the Win/Linux values, so a
 * control with this class needs no platform branch. desktop-titlebar.test.ts
 * asserts the geometry.
 *
 * Height only, no width and no `display`: the shell's sidebar toggle is a
 * square icon box and adds its own width and `flex`; Back is an icon plus a
 * label, sized by its content, and takes its display from `.kx-desktop-back`
 * so it stays hidden on the web.
 */
export const TITLEBAR_CONTROL_CLASS =
  'text-muted-foreground hover:text-foreground duration-normal fixed top-[var(--kx-titlebar-control-top)] left-[var(--kx-titlebar-control-left)] z-50 h-[var(--kx-titlebar-control-size)] shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] ease-out [-webkit-app-region:no-drag] [app-region:no-drag] active:scale-[0.96]';
