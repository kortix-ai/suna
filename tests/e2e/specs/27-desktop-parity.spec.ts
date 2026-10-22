// The 27 desktop parity journeys in a browser user agent. They live in
// e2e/helpers/desktop-parity.ts; 27-desktop-parity-desktop.spec.ts runs the
// same journeys as the desktop app.
import { defineDesktopParity } from "../helpers/desktop-parity";

if (process.env.E2E_DESKTOP_NATIVE !== "1") defineDesktopParity("web");
