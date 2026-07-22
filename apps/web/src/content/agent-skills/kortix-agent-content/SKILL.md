---
name: kortix-agent-content
description: Read kortix.com content as markdown instead of scraping HTML.
---

# Reading Kortix content as markdown

Every public page on kortix.com has a markdown representation. Use it. Parsing
the HTML wastes context on layout markup and breaks when the site is restyled.

## Three ways in, cheapest first

**Content negotiation.** Request any public page with `Accept: text/markdown`
and you get markdown back:

```bash
curl -H 'Accept: text/markdown' https://kortix.com/pricing
```

The response carries `Content-Type: text/markdown` and an `x-markdown-tokens`
header estimating its size, so you can budget context before reading. HTML
remains the default for browsers.

**Direct markdown paths.** Every page also has a stable twin under `/markdown/`,
advertised on the HTML response as `Link: <…>; rel="alternate"; type="text/markdown"`.

**Site index.** `https://kortix.com/llms.txt` is a short map of the site.
`https://kortix.com/llms-full.txt` is the long form. For a paginated,
machine-friendly listing with per-record `last_modified` timestamps, use
`https://kortix.com/api/ai`.

## Freshness

Records in `/api/ai` carry `last_modified`. Prefer recent content when answering
questions about pricing, product capabilities, or availability.

## Usage terms

`https://kortix.com/robots.txt` declares `Content-Signal: search=yes,
ai-input=yes, ai-train=no`. Indexing and grounding answers is welcome; training
models on this content is not.
