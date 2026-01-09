'use client';

import { cn } from '@/lib/utils';

// Kortix symbol SVG
function KortixSymbol({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 30 25" 
      fill="currentColor" 
      className={className}
    >
      <path d="M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z"/>
    </svg>
  );
}

/**
 * Universal app download URL - middleware auto-redirects to correct store based on device
 */
export const APP_DOWNLOAD_URL = 'https://www.kortix.com/app';

export interface AppDownloadQRProps {
  /** Size of the QR code in pixels */
  size?: number;
  /** Additional class names for the container */
  className?: string;
  /** Whether to show the Kortix logo in the center */
  showLogo?: boolean;
  /** Size of the center logo */
  logoSize?: number;
}

/**
 * QR code component that links to /app - automatically redirects to the correct
 * app store (iOS App Store or Google Play) based on the scanning device.
 */
export function AppDownloadQR({ 
  size = 200, 
  className,
  showLogo = true,
  logoSize = 32,
}: AppDownloadQRProps) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(APP_DOWNLOAD_URL)}&format=svg&ecc=H`;

  return (
    <div className={cn("relative bg-white rounded-2xl p-4 shadow-lg", className)}>
      <img 
        src={qrUrl}
        alt="Scan to download Kortix - redirects to App Store or Google Play based on your device"
        width={size}
        height={size}
        className="block"
      />
      {showLogo && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-white p-2 rounded-xl shadow-md">
            <KortixSymbol size={logoSize} className="text-black" />
          </div>
        </div>
      )}
    </div>
  );
}

