'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { encode } from 'uqr';

import { cn } from '../../lib/utils';
import { useTranslations } from '../../i18n';

/** The redirect a scan opens: iOS goes to the App Store, Android to Google Play. */
export const MOBILE_QR_PATH = '/download/mobile';

const subscribeToOrigin = () => () => {};
const getBrowserOrigin = () => window.location.origin;
const getServerOrigin = () => '';

/** QR modules as ONE path, one unit per module. */
function qrPath(text: string): { size: number; d: string } {
  const { data, size } = encode(text, { border: 0, ecc: 'M' });
  let d = '';
  data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size, d };
}

/**
 * One QR code for both stores. It encodes THIS deployment's
 * `/download/mobile` (kortix.com, dev, a preview), and that route sends the
 * scanning phone to its own store, so the visitor never picks one.
 *
 * Dark modules on a white tile in both themes: phone cameras read
 * dark-on-light reliably, and many Android scanners reject an inverted code.
 * The tile's padding is the quiet zone.
 *
 * The origin is a browser fact, read after hydration. The server render keeps
 * the tile's footprint empty, so nothing shifts when the code appears.
 */
export function MobileStoreQr({ className }: { className?: string }) {
  const t = useTranslations('mobileAppPromo');
  const origin = useSyncExternalStore(subscribeToOrigin, getBrowserOrigin, getServerOrigin);
  const url = origin ? `${origin}${MOBILE_QR_PATH}` : '';
  const qr = useMemo(() => (url ? qrPath(url) : null), [url]);

  return (
    <div className={cn('size-24 shrink-0 rounded-md border bg-white p-2', className)}>
      {qr ? (
        <svg
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          className='size-full'
          shapeRendering='crispEdges'
          role='img'
          aria-label={t('qrLabel')}
          data-qr-url={url}
        >
          <path d={qr.d} fill='#000' />
        </svg>
      ) : null}
    </div>
  );
}
