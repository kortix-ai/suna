const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;

function contains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function centeredBounds(display, width, height) {
  const area = display.workArea || display;
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  };
}

function restoreWindowState(saved, displays, primaryDisplay, fallbackBounds) {
  const fallback = fallbackBounds || {
    width: MIN_WIDTH,
    height: MIN_HEIGHT,
  };
  const raw = saved?.bounds || fallback;
  const bounds = {
    x: Number.isFinite(raw.x) ? Math.round(raw.x) : undefined,
    y: Number.isFinite(raw.y) ? Math.round(raw.y) : undefined,
    width: Math.max(MIN_WIDTH, Math.round(Number(raw.width) || fallback.width)),
    height: Math.max(MIN_HEIGHT, Math.round(Number(raw.height) || fallback.height)),
  };
  const positioned = Number.isFinite(bounds.x) && Number.isFinite(bounds.y);
  const areas = displays.map((display) => display.workArea || display);
  const fullyVisible = positioned && areas.some((area) => contains(area, bounds));

  if (fullyVisible) {
    return { bounds, maximized: Boolean(saved?.maximized) };
  }

  const intersectingArea = positioned
    ? areas
        .map((area) => ({ area, overlap: intersectionArea(bounds, area) }))
        .filter(({ overlap }) => overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)[0]?.area
    : null;
  const target = intersectingArea || primaryDisplay.workArea || primaryDisplay;
  const width = Math.min(bounds.width, target.width);
  const height = Math.min(bounds.height, target.height);
  const fitted = intersectingArea
    ? {
        x: Math.min(Math.max(bounds.x, target.x), target.x + target.width - width),
        y: Math.min(Math.max(bounds.y, target.y), target.y + target.height - height),
        width,
        height,
      }
    : centeredBounds(target, width, height);

  return {
    bounds: fitted,
    maximized: Boolean(saved?.maximized),
  };
}

module.exports = { MIN_WIDTH, MIN_HEIGHT, restoreWindowState };
