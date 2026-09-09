function isConfiguredAppUrl(url, appUrl) {
  try {
    const sender = new URL(url);
    return (
      (sender.protocol === 'https:' || sender.protocol === 'http:') &&
      sender.origin === new URL(appUrl).origin
    );
  } catch {
    return false;
  }
}

function isTrustedAppSender(event, appWebContents, appUrl) {
  const frame = event.senderFrame;
  return Boolean(
    frame &&
    appWebContents &&
    event.sender === appWebContents &&
    frame === appWebContents.mainFrame &&
    isConfiguredAppUrl(frame.url, appUrl),
  );
}

module.exports = { isConfiguredAppUrl, isTrustedAppSender };
