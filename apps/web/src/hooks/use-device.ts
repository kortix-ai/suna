import * as React from "react";

type DeviceOS = "mac" | "windows" | "linux" | "unknown";

export function useDevice(): DeviceOS {
  const [os, setOs] = React.useState<DeviceOS>("unknown");

  React.useEffect(() => {
    const detectOS = (): DeviceOS => {
      if (typeof window === "undefined") {
        return "unknown";
      }

      const platform = navigator.platform.toLowerCase();
      const userAgent = navigator.userAgent.toLowerCase();

      // Check for macOS
      if (
        platform.includes("mac") ||
        userAgent.includes("mac os") ||
        userAgent.includes("macintosh")
      ) {
        return "mac";
      }

      // Check for Windows
      if (platform.includes("win") || userAgent.includes("windows")) {
        return "windows";
      }

      // Check for Linux
      if (
        platform.includes("linux") ||
        userAgent.includes("linux") ||
        (!platform.includes("mac") && !platform.includes("win"))
      ) {
        return "linux";
      }

      return "unknown";
    };

    setOs(detectOS());
  }, []);

  return os;
}
