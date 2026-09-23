import { describe, expect, test } from 'bun:test';

import { extractTeamsAttachments, inlineImageUrls, teamsMessageHasImage } from '../channels/teams/types';

// In a personal chat a pasted image arrives as an `image/*` attachment. In a
// CHANNEL or GROUP CHAT it arrives inside a `text/html` attachment as an <img>
// tag — and nothing parsed those. An image pasted into a channel was invisible:
// no attachment to download, and `teamsMessageHasImage` returned false, so the
// turn never reached a model that can see images.

const SMBA = 'https://smba.trafficmanager.net/emea/tenant/v3/attachments/0-weu-d8-abc/views/original';
const GRAPH = 'https://graph.microsoft.com/v1.0/chats/19:x/messages/1/hostedContents/aWQ=/$value';
const EMOJI =
  '<img itemtype="http://schema.skype.com/Emoji" itemscope="" alt="🙂" src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/emoticons/smile/default/20_f.png">';

const channelMessage = (html: string, extra: Array<Record<string, unknown>> = []) => ({
  type: 'message',
  text: 'what is this?',
  attachments: [...extra, { contentType: 'text/html', content: html }],
});

describe('inlineImageUrls', () => {
  test('finds a Bot Framework attachment image in a channel message body', () => {
    const html = `<div><img itemtype="http://schema.skype.com/AMSImage" src="${SMBA}" width="250"></div><p>what is this?</p>`;
    expect(inlineImageUrls(html)).toEqual([SMBA]);
  });

  test('finds a Graph hostedContents image', () => {
    expect(inlineImageUrls(`<img src="${GRAPH}">`)).toEqual([GRAPH]);
  });

  test('skips Teams` own emoji, which are also <img> tags', () => {
    expect(inlineImageUrls(`<p>nice ${EMOJI}</p>`)).toEqual([]);
  });

  test('decodes HTML entities in the src', () => {
    const escaped = 'https://smba.trafficmanager.net/emea/t/v3/attachments/a/views/original?x=1&amp;y=2';
    expect(inlineImageUrls(`<img src="${escaped}">`)).toEqual([
      'https://smba.trafficmanager.net/emea/t/v3/attachments/a/views/original?x=1&y=2',
    ]);
  });

  test('accepts single-quoted src attributes', () => {
    expect(inlineImageUrls(`<img src='${SMBA}'>`)).toEqual([SMBA]);
  });

  test('NEVER extracts a foreign host — the proxy would hand it the bot token', () => {
    // downloadTeamsFile attaches the bot connector token to Bot Framework
    // hosts. Extraction is the first gate; it must not widen that surface.
    for (const src of [
      'https://evil.example/x.png',
      'https://attacker.azurewebsites.net/x.png',
      'https://trafficmanager.net.evil.example/x.png',
    ]) {
      expect(inlineImageUrls(`<img src="${src}">`), src).toEqual([]);
    }
  });

  test('rejects plain http and non-URLs', () => {
    expect(inlineImageUrls('<img src="http://smba.trafficmanager.net/a">')).toEqual([]);
    expect(inlineImageUrls('<img src="data:image/png;base64,AAAA">')).toEqual([]);
    expect(inlineImageUrls('<img src="">')).toEqual([]);
    expect(inlineImageUrls('<img alt="no src">')).toEqual([]);
  });

  test('lists a repeated image once', () => {
    expect(inlineImageUrls(`<img src="${SMBA}"><img src="${SMBA}">`)).toEqual([SMBA]);
  });
});

describe('extractTeamsAttachments — inline images', () => {
  test('a channel image becomes an image the agent can download', () => {
    const refs = extractTeamsAttachments(channelMessage(`<img src="${SMBA}">`) as never);
    expect(refs).toEqual([{ name: 'image', downloadUrl: SMBA, isImage: true }]);
  });

  test('it counts as an image, so the turn is routed to a vision model', () => {
    expect(teamsMessageHasImage(channelMessage(`<img src="${SMBA}">`) as never)).toBe(true);
  });

  test('a channel message with only emoji is NOT an image message', () => {
    expect(teamsMessageHasImage(channelMessage(`<p>nice ${EMOJI}</p>`) as never)).toBe(false);
  });

  test('several images get distinct names', () => {
    const refs = extractTeamsAttachments(channelMessage(`<img src="${SMBA}"><img src="${GRAPH}">`) as never);
    expect(refs.map((r) => r.name)).toEqual(['image', 'image-2']);
  });

  test('an image Teams sends BOTH as image/* and inline is listed once', () => {
    // A personal chat can carry the same picture as an `image/*` attachment AND
    // inside the HTML body; the agent should not download it twice.
    const refs = extractTeamsAttachments(
      channelMessage(`<img src="${SMBA}">`, [{ contentType: 'image/*', contentUrl: SMBA }]) as never,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].downloadUrl).toBe(SMBA);
  });

  test('a OneDrive file alongside an inline image yields both', () => {
    const refs = extractTeamsAttachments(
      channelMessage(`<img src="${SMBA}">`, [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'report.pdf',
          content: { downloadUrl: 'https://contoso.sharepoint.com/report.pdf', fileType: 'pdf' },
        },
      ]) as never,
    );
    expect(refs.map((r) => r.name)).toEqual(['report.pdf', 'image']);
  });

  test('a text/html body with no images adds nothing', () => {
    expect(extractTeamsAttachments(channelMessage('<p>just words</p>') as never)).toEqual([]);
  });

  test('a non-string text/html content is ignored rather than thrown on', () => {
    const odd = { type: 'message', attachments: [{ contentType: 'text/html', content: { downloadUrl: 'x' } }] };
    expect(extractTeamsAttachments(odd as never)).toEqual([]);
  });
});
