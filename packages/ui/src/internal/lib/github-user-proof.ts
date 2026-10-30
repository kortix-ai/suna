type GitHubProofMessage =
  | { type: 'github-connect-success'; provider_token: string }
  | { type: 'github-connect-error'; message: string };

/** Ask GitHub for a short-lived user proof without retaining it in app state. */
export function requestGitHubUserProof(): Promise<string> {
  const popup = window.open('/auth/github-connect', 'kortix-github-proof', 'popup,width=520,height=720');
  if (!popup) return Promise.reject(new Error('Allow pop-ups to verify your GitHub access.'));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { token: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(closePoll);
      window.clearTimeout(timeout);
      if ('error' in result) reject(result.error);
      else resolve(result.token);
    };
    const onMessage = (event: MessageEvent<GitHubProofMessage>) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'github-connect-success' && event.data.provider_token) {
        finish({ token: event.data.provider_token });
      } else if (event.data?.type === 'github-connect-error') {
        finish({ error: new Error(event.data.message || 'GitHub verification failed.') });
      }
    };
    window.addEventListener('message', onMessage);
    const closePoll = window.setInterval(() => {
      if (popup.closed) finish({ error: new Error('GitHub verification was cancelled.') });
    }, 500);
    const timeout = window.setTimeout(
      () => finish({ error: new Error('GitHub verification timed out. Try again.') }),
      120_000,
    );
    popup.focus();
  });
}
