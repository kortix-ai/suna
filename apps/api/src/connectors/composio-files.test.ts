import { expect, test } from 'bun:test';
import { composioFileUpload, uploadFileArgs, type FileUpload } from './composio-files';

const fileField = {
  type: 'object',
  required: ['name', 'mimetype', 's3key'],
  properties: { name: { type: 'string' }, mimetype: { type: 'string' }, s3key: { type: 'string' } },
  file_uploadable: true,
};

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    videoFile: fileField,
    // Gmail `attachment`: one file or a list of files.
    attachment: { anyOf: [fileField, { type: 'array', items: fileField }] },
    message: { type: 'object', properties: { file: fileField } },
  },
};

function fakeUpload(calls: Array<[string, unknown]>): FileUpload {
  return async (url, hint) => {
    calls.push([url, hint]);
    return { name: hint.name ?? 'clip.mp4', mimetype: hint.mimetype ?? 'video/mp4', s3key: `uploaded/${calls.length}` };
  };
}

test('a URL string in a file field is uploaded and replaced by the Composio file reference', async () => {
  const calls: Array<[string, unknown]> = [];
  const out = await uploadFileArgs(
    { title: 'https://example.com/not-a-file', videoFile: 'https://example.com/clip.mp4' },
    schema,
    fakeUpload(calls),
  );
  expect(out).toEqual({
    title: 'https://example.com/not-a-file',
    videoFile: { name: 'clip.mp4', mimetype: 'video/mp4', s3key: 'uploaded/1' },
  });
  expect(calls).toEqual([['https://example.com/clip.mp4', {}]]);
});

test('an object whose s3key or url is a URL is uploaded with its name and mimetype', async () => {
  const calls: Array<[string, unknown]> = [];
  const out = await uploadFileArgs(
    {
      videoFile: { name: 'a.mov', mimetype: 'video/quicktime', s3key: 'https://example.com/a' },
      message: { file: { url: 'http://example.com/b.pdf' } },
    },
    schema,
    fakeUpload(calls),
  );
  expect(out.videoFile).toEqual({ name: 'a.mov', mimetype: 'video/quicktime', s3key: 'uploaded/1' });
  expect(out.message).toEqual({ file: { name: 'clip.mp4', mimetype: 'video/mp4', s3key: 'uploaded/2' } });
  expect(calls).toEqual([
    ['https://example.com/a', { name: 'a.mov', mimetype: 'video/quicktime' }],
    ['http://example.com/b.pdf', {}],
  ]);
});

test('an existing Composio file reference and non-file fields pass through unchanged', async () => {
  const calls: Array<[string, unknown]> = [];
  const args = {
    title: 'hello',
    videoFile: { name: 'a.mp4', mimetype: 'video/mp4', s3key: '123/youtube/key' },
    extra: 'https://example.com/x',
  };
  expect(await uploadFileArgs(args, schema, fakeUpload(calls))).toEqual(args);
  expect(calls).toEqual([]);
});

test('a file field inside anyOf takes one file or a list of files', async () => {
  const calls: Array<[string, unknown]> = [];
  const one = await uploadFileArgs({ attachment: 'https://example.com/1.pdf' }, schema, fakeUpload(calls));
  const many = await uploadFileArgs(
    { attachment: ['https://example.com/2.pdf', { name: 'k', mimetype: 'a/b', s3key: 'kept' }] },
    schema,
    fakeUpload(calls),
  );
  expect(one.attachment).toEqual({ name: 'clip.mp4', mimetype: 'video/mp4', s3key: 'uploaded/1' });
  expect(many.attachment).toEqual([
    { name: 'clip.mp4', mimetype: 'video/mp4', s3key: 'uploaded/2' },
    { name: 'k', mimetype: 'a/b', s3key: 'kept' },
  ]);
});

test('a failed upload names the field and keeps the caller status', async () => {
  const failing: FileUpload = async () => {
    throw Object.assign(new Error('the URL answered HTTP 404'), { status: 400 });
  };
  const error = await uploadFileArgs({ attachment: ['https://example.com/x'] }, schema, failing).catch((e) => e);
  expect(error.message).toBe('file upload failed for attachment[0]: the URL answered HTTP 404');
  expect(error.status).toBe(400);
});

test('no schema means no upload', async () => {
  const args = { videoFile: 'https://example.com/clip.mp4' };
  expect(await uploadFileArgs(args, null, fakeUpload([]))).toBe(args);
});

test('the uploader reads the URL through the given fetch and hands Composio a named File', async () => {
  const uploaded: Array<{ file: File; toolSlug: string; toolkitSlug: string }> = [];
  const upload = composioFileUpload(
    { upload: async (input) => (uploaded.push(input as never), { name: 'clip.mp4', mimetype: 'video/mp4', s3key: 'k1' }) },
    'youtube',
    'YOUTUBE_MULTIPART_UPLOAD_VIDEO',
    async () => new Response('bytes', { headers: { 'content-type': 'video/mp4; charset=binary' } }),
  );
  expect(await upload('https://example.com/media/clip.mp4?sig=1', {})).toEqual({
    name: 'clip.mp4',
    mimetype: 'video/mp4',
    s3key: 'k1',
  });
  expect(uploaded[0]!.file.name).toBe('clip.mp4');
  expect(uploaded[0]!.file.type).toBe('video/mp4');
  expect(uploaded[0]!.toolkitSlug).toBe('youtube');
});

test('the uploader refuses a URL that does not answer 2xx, as a caller error', async () => {
  const upload = composioFileUpload(
    { upload: async () => ({ name: '', mimetype: '', s3key: '' }) },
    'youtube',
    'YOUTUBE_MULTIPART_UPLOAD_VIDEO',
    async () => new Response('nope', { status: 404 }),
  );
  const error = await upload('https://example.com/clip.mp4', {}).catch((e) => e);
  expect(error.message).toBe('the URL answered HTTP 404');
  expect(error.status).toBe(400);
});
