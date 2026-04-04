import { describe, expect, test } from 'bun:test'

/**
 * Regression tests for response.json() → !response.ok ordering.
 *
 * When proxying to sandbox or platform endpoints, error responses may
 * not be JSON (e.g. nginx returning HTML 502, Cloudflare error pages,
 * or plain-text "Internal Server Error").  Calling response.json()
 * before checking response.ok causes a SyntaxError that masks the
 * real HTTP status and error message.
 *
 * These tests verify the correct pattern: check response.ok first,
 * then attempt to parse JSON inside a try/catch for error extraction.
 */

describe('response.json() parse order safety', () => {
  /**
   * Simulates the share endpoint's proxy logic with the fix applied:
   * check resp.ok before calling resp.json().
   */
  async function handleProxyResponse(resp: Response): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    if (!resp.ok) {
      let errorBody: Record<string, unknown> = { error: `Upstream returned ${resp.status}` }
      try { errorBody = await resp.json() as Record<string, unknown> } catch { /* non-JSON error */ }
      return { status: resp.status, body: errorBody }
    }

    const result = await resp.json() as Record<string, unknown>
    return { status: 200, body: result }
  }

  test('handles JSON error response and extracts error message', async () => {
    const resp = new Response(
      JSON.stringify({ error: 'sandbox not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )

    const result = await handleProxyResponse(resp)
    expect(result.status).toBe(404)
    expect(result.body.error).toBe('sandbox not found')
  })

  test('handles non-JSON error response without throwing SyntaxError', async () => {
    // Simulates nginx returning an HTML 502 page
    const resp = new Response(
      '<html><body><h1>502 Bad Gateway</h1></body></html>',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    )

    const result = await handleProxyResponse(resp)
    expect(result.status).toBe(502)
    expect(result.body.error).toBe('Upstream returned 502')
  })

  test('handles plain-text error response without throwing', async () => {
    const resp = new Response('Internal Server Error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    })

    const result = await handleProxyResponse(resp)
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('Upstream returned 500')
  })

  test('handles empty error response body', async () => {
    const resp = new Response(null, { status: 503 })

    const result = await handleProxyResponse(resp)
    expect(result.status).toBe(503)
    expect(result.body.error).toBe('Upstream returned 503')
  })

  test('parses successful JSON response normally', async () => {
    const resp = new Response(
      JSON.stringify({ url: 'https://share.example.com/abc', token: 'tok_123' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

    const result = await handleProxyResponse(resp)
    expect(result.status).toBe(200)
    expect(result.body.url).toBe('https://share.example.com/abc')
    expect(result.body.token).toBe('tok_123')
  })

  /**
   * Demonstrates the old (broken) pattern: calling resp.json() before
   * checking resp.ok throws SyntaxError on non-JSON error responses.
   */
  test('old pattern throws SyntaxError on non-JSON error (regression guard)', async () => {
    const resp = new Response(
      '<html><body><h1>502 Bad Gateway</h1></body></html>',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    )

    // This is what the old code did — json() before ok check
    await expect(resp.json()).rejects.toThrow()
  })
})
