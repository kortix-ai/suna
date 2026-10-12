import { $, rpc } from './rpc';

const id = new URL(location.href).searchParams.get('id') ?? '';
rpc<{ sessionTitle: string; projectName: string; browser: string } | undefined>({ kortix: 'consent-info', attachmentId: id }).then((i) => {
  if (!i) return window.close();
  $('title').textContent = `Let Kortix use ${i.browser}?`;
  $('body').textContent = `The session "${i.sessionTitle}" in ${i.projectName} wants to use this browser.`;
});
for (const d of ['deny', 'session', 'project'] as const) {
  $(d).onclick = () => void rpc({ kortix: 'consent', attachmentId: id, decision: d });
}
