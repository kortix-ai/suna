// The Dock / taskbar badge for finished turns the user has not seen yet. The
// web app owns the count (TurnAttentionBadge sends it through
// `set_badge_count`); the frameless window shows no favicon, so this badge is
// the one sign that outlasts the 8 s toast.

const DOT_SIZE = 16;

/** A Kortix-green (#199338) dot, BGRA, for the Windows taskbar overlay. */
function dotBitmap() {
  const pixels = Buffer.alloc(DOT_SIZE * DOT_SIZE * 4);
  const center = DOT_SIZE / 2;
  for (let y = 0; y < DOT_SIZE; y++) {
    for (let x = 0; x < DOT_SIZE; x++) {
      if ((x + 0.5 - center) ** 2 + (y + 0.5 - center) ** 2 > (center - 0.5) ** 2) continue;
      pixels.set([0x38, 0x93, 0x19, 0xff], (y * DOT_SIZE + x) * 4);
    }
  }
  return pixels;
}

/**
 * macOS and Linux show the number (`app.setBadgeCount`: the Dock tile, the
 * Unity launcher). Windows has no count API, so it gets an overlay dot with the
 * count in its accessible description. 0 removes the badge.
 */
function setAttentionBadge({ app, window, nativeImage, platform }, count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid badge count.');
  if (platform !== 'win32') {
    app.setBadgeCount(count);
    return;
  }
  if (!window || window.isDestroyed()) return;
  if (count === 0) {
    window.setOverlayIcon(null, '');
    return;
  }
  const dot = nativeImage.createFromBitmap(dotBitmap(), { width: DOT_SIZE, height: DOT_SIZE });
  window.setOverlayIcon(dot, `${count} finished session${count === 1 ? '' : 's'} you have not seen`);
}

module.exports = { setAttentionBadge };
