function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function decidePopup({ url, disposition, features }) {
  const wantsOpener = !/\bnoopener\b/i.test(features || '');
  if (
    disposition === 'new-window' &&
    wantsOpener &&
    (!url || url === 'about:blank' || isHttpUrl(url))
  ) {
    return 'popup';
  }
  return isHttpUrl(url) ? 'external' : 'deny';
}

function isAllowedPopupNavigation(url) {
  return url === 'about:blank' || isHttpUrl(url);
}

module.exports = { decidePopup, isAllowedPopupNavigation };
