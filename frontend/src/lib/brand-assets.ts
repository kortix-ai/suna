/**
 * Brand Assets Configuration for Adentic
 * This module defines the static assets and their paths
 */

export interface BrandAssets {
  logo: {
    primary: string;
    icon: string;
    favicon: string;
    appleTouchIcon: string;
  };
  openGraph: {
    image: string;
    width: number;
    height: number;
  };
  colors: {
    primary: string;
    primaryRgb: string;
    primaryHsl: string;
  };
}

export const brandAssets: BrandAssets = {
  logo: {
    primary: '/logo.png',
    icon: '/icon.svg',
    favicon: '/favicon.ico',
    appleTouchIcon: '/apple-touch-icon.png',
  },
  openGraph: {
    image: '/og-image.png',
    width: 1200,
    height: 630,
  },
  colors: {
    primary: '#CC3A00',
    primaryRgb: '204, 58, 0',
    primaryHsl: '17, 100%, 40%',
  },
};

// Helper to get asset URL with cache busting
export const getAssetUrl = (path: string, version?: string): string => {
  const v = version || process.env.NEXT_PUBLIC_BUILD_ID || Date.now().toString();
  return `${path}?v=${v}`;
};

// Check if asset exists (client-side only)
export const checkAssetExists = async (path: string): Promise<boolean> => {
  if (typeof window === 'undefined') return true;

  try {
    const response = await fetch(path, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
};

// Get fallback for missing assets
export const getAssetWithFallback = (
  primaryPath: string,
  fallbackText: string = 'Adentic'
): string | { text: string } => {
  // In production, always return the path
  // The fallback text is returned as an object for components to handle
  if (process.env.NODE_ENV === 'production') {
    return primaryPath;
  }

  // In development, we can check and provide fallback
  if (typeof window !== 'undefined') {
    checkAssetExists(primaryPath).then((exists) => {
      if (!exists) {
        console.warn(`Asset not found: ${primaryPath}, using text fallback`);
      }
    });
  }

  return primaryPath;
};