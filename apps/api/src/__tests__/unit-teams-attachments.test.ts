import { describe, expect, test } from 'bun:test';
import { extractTeamsAttachments } from '../channels/teams/types';

/**
 * An image pasted into a Teams chat (dev, 2026-09-18: "what do you see on
 * this image") is not a OneDrive `file.download.info` attachment — it is an
 * `image/*` attachment whose `contentUrl` is a token-protected Bot Framework
 * URL. The prompt builder only knew the first shape, so the agent answered
 * "there are no file URLs in the prompt".
 */
describe('extractTeamsAttachments', () => {
  test('OneDrive file shares (personal chat) keep their downloadUrl', () => {
    const refs = extractTeamsAttachments({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'report.pdf',
          content: { downloadUrl: 'https://kortixssotest-my.sharepoint.com/personal/x/report.pdf', fileType: 'pdf' },
        },
      ],
    });
    expect(refs).toEqual([{ name: 'report.pdf', downloadUrl: 'https://kortixssotest-my.sharepoint.com/personal/x/report.pdf', fileType: 'pdf' }]);
  });

  test('a pasted image is an image/* attachment with a Bot Framework contentUrl', () => {
    const refs = extractTeamsAttachments({
      type: 'message',
      attachments: [
        { contentType: 'text/html' },
        {
          contentType: 'image/png',
          contentUrl: 'https://smba.trafficmanager.net/emea/36009a52/v3/attachments/0-abc/views/original',
          name: 'image.png',
        },
      ],
    });
    expect(refs).toEqual([
      {
        name: 'image.png',
        downloadUrl: 'https://smba.trafficmanager.net/emea/36009a52/v3/attachments/0-abc/views/original',
        fileType: 'png',
      },
    ]);
  });

  test('an image without a name gets one from its type; html/card attachments are ignored', () => {
    const refs = extractTeamsAttachments({
      type: 'message',
      attachments: [
        { contentType: 'image/jpeg', contentUrl: 'https://smba.trafficmanager.net/emea/x/v3/attachments/1/views/original' },
        { contentType: 'application/vnd.microsoft.card.adaptive', content: {} },
      ],
    });
    expect(refs).toEqual([
      { name: 'image.jpeg', downloadUrl: 'https://smba.trafficmanager.net/emea/x/v3/attachments/1/views/original', fileType: 'jpeg' },
    ]);
  });
});
