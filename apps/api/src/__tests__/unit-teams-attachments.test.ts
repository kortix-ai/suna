import { describe, expect, test } from 'bun:test';
import { extractTeamsAttachments, teamsMessageHasImage } from '../channels/teams/types';

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
    expect(teamsMessageHasImage({ type: 'message', attachments: [] })).toBe(false);
  });

  test('a pasted image is an image/* attachment with a Bot Framework contentUrl', () => {
    const activity = {
      type: 'message',
      attachments: [
        { contentType: 'text/html' },
        {
          contentType: 'image/png',
          contentUrl: 'https://smba.trafficmanager.net/emea/36009a52/v3/attachments/0-abc/views/original',
          name: 'image.png',
        },
      ],
    };
    expect(extractTeamsAttachments(activity)).toEqual([
      {
        name: 'image.png',
        downloadUrl: 'https://smba.trafficmanager.net/emea/36009a52/v3/attachments/0-abc/views/original',
        fileType: 'png',
        isImage: true,
      },
    ]);
    expect(teamsMessageHasImage(activity)).toBe(true);
  });

  test('jpeg normalizes to a real .jpg extension; cards are ignored', () => {
    const refs = extractTeamsAttachments({
      type: 'message',
      attachments: [
        { contentType: 'image/jpeg', contentUrl: 'https://smba.trafficmanager.net/emea/x/v3/attachments/1/views/original' },
        { contentType: 'application/vnd.microsoft.card.adaptive', content: {} },
      ],
    });
    expect(refs).toEqual([
      {
        name: 'image.jpg',
        downloadUrl: 'https://smba.trafficmanager.net/emea/x/v3/attachments/1/views/original',
        fileType: 'jpg',
        isImage: true,
      },
    ]);
  });

  /**
   * The shape Teams ACTUALLY sends for a pasted screenshot — verified on dev
   * 2026-09-19, session 196a99f5. The subtype is the literal `*`, so the old
   * code named the file `image.*`, which is not a filename.
   */
  test('the wildcard image/* type produces a filename, not "image.*"', () => {
    const refs = extractTeamsAttachments({
      type: 'message',
      attachments: [
        {
          contentType: 'image/*',
          contentUrl:
            'https://smba.trafficmanager.net/emea/36009a52-46d2-44bc-ba56-57a87e485e0a/v3/attachments/0-weu-d21-b7b5/views/original',
        },
      ],
    });
    expect(refs).toEqual([
      {
        name: 'image',
        downloadUrl:
          'https://smba.trafficmanager.net/emea/36009a52-46d2-44bc-ba56-57a87e485e0a/v3/attachments/0-weu-d21-b7b5/views/original',
        isImage: true,
      },
    ]);
    expect(refs[0]?.name).not.toContain('*');
  });
});
