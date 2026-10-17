// The 27 desktop parity journeys as the desktop app: the KortixDesktop user
// agent, or the real Electron shell with E2E_DESKTOP_NATIVE=1, which also runs
// the native-only journeys. The journeys live in e2e/helpers/desktop-parity.ts.
import {
  defineDesktopParity,
  defineNativeDesktopParity,
} from "../helpers/desktop-parity";

defineDesktopParity("desktop");
defineNativeDesktopParity();
