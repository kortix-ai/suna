export function decodedResponseHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers);
  // fetch transparently decodes gzip/br/zstd. Re-emitting the original encoding
  // or compressed content length makes downstream clients decode plain bytes a
  // second time (Bun surfaces this as ZstdDecompressionError).
  headers.delete('content-encoding');
  headers.delete('content-length');
  return headers;
}
