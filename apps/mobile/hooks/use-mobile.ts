import { useWindowDimensions } from "react-native";

/** Matches Tailwind `lg` (1024px) for responsive modal behavior. */
const LG_BREAKPOINT = 1024;

export function useIsMobile() {
  const { width } = useWindowDimensions();
  return width < LG_BREAKPOINT;
}
