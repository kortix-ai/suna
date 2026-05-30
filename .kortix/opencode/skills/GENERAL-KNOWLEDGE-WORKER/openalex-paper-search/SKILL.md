---
name: openalex-paper-search
description: "Academic paper search powered by OpenAlex -- the free, open catalog of 240M+ scholarly works. Use when the user needs to find academic papers, research articles, literature for a topic, citation data, author publications, or any scholarly source. Triggers on: 'find papers on', 'academic research about', 'what studies exist', 'literature review', 'find citations', 'scholarly articles about', 'who published on', 'papers by [author]', 'highly cited papers on', any request for peer-reviewed or academic sources. Also use during deep research when you need to ground findings in academic literature. Do NOT use for general web searches -- use web_search for that."
---

# Academic Paper Search (OpenAlex)

Search 240M+ scholarly works using the OpenAlex API -- completely free, no API key required, no SDK needed. Just `curl` or `bash` with URL construction.

**Full docs:** https://docs.openalex.org

## Quick Start

OpenAlex is a REST API. You query it by constructing URLs and fetching them with `curl`. All responses are JSON.

```bash
# Search for papers about "transformer architecture"
curl -s "https://api.openalex.org/works?search=transformer+architecture&per_page=5&mailto=agent@kortix.ai" | python3 -m json.tool
```

**Important:** Always include `mailto=agent@kortix.ai` (or any valid email) in every request. Without it, you're limited to 1 request/second. With it, you get 10 requests/second (the "polite pool").

## Core Concepts

### Entities

OpenAlex has these entity types (all queryable):

| Entity | Endpoint | Count | Description |
|--------|----------|-------|-------------|
| **Works** | `/works` | 240M+ | Papers, articles, books, datasets, theses |
| **Authors** | `/authors` | 90M+ | People who create works |
| **Sources** | `/sources` | 250K+ | Journals, repositories, conferences |
| **Institutions** | `/institutions` | 110K+ | Universities, research orgs |
| **Topics** | `/topics` | 4K+ | Research topics (hierarchical) |

### Work Object -- Key Fields

When you fetch a work, these are the most useful fields:

```
id                        OpenAlex ID (e.g., "https://openalex.org/W2741809807")
doi                       DOI URL
title / display_name      Paper title
publication_year          Year published
publication_date          Full date (YYYY-MM-DD)
cited_by_count            Number of incoming citations
fwci                      Field-Weighted Citation Impact (normalized)
type                      article, preprint, review, book, dataset, etc.
language                  ISO 639-1 code (e.g., "en")
is_retracted              Boolean
open_access.is_oa         Boolean -- is it freely accessible?
open_access.oa_url        Direct URL to free version
authorships               List of authors with names, institutions, ORCIDs
abstract_inverted_index   Abstract as inverted index (needs reconstruction)
referenced_works          List of OpenAlex IDs this work cites (outgoing)
related_works             Algorithmically related works
cited_by_api_url          API URL to get works that cite this one (incoming)
topics                    Assigned research topics with scores
keywords                  Extracted keywords with scores
primary_location          Where the work is published (journal, repo)
best_oa_location          Best open access location with PDF link
```

### Reconstructing Abstracts

OpenAlex stores abstracts as inverted indexes for legal reasons. To get plaintext, reconstruct:

```python
import json, sys
# Read the abstract_inverted_index from a work object
inv_idx = work["abstract_inverted_index"]
if inv_idx:
    words = [""] * (max(max(positions) for positions in inv_idx.values()) + 1)
    for word, positions in inv_idx.items():
        for pos in positions:
            words[pos] = word
    abstract = " ".join(words)
```

Or in bash with `python3 -c`:
```bash
# Pipe a work JSON into this to extract the abstract
echo "$WORK_JSON" | python3 -c "
import json,sys
w=json.load(sys.stdin)
idx=w.get('abstract_inverted_index',{})
if idx:
    words=['']*( max(max(p) for p in idx.values())+1 )
    for word,positions in idx.items():
        for pos in positions: words[pos]=word
    print(' '.join(words))
"
```

## Searching for Papers

### Basic Keyword Search

Searches across titles, abstracts, and fulltext. Uses stemming and stop-word removal.

```bash
# Simple search
curl -s "https://api.openalex.org/works?search=large+language+models&mailto=agent@kortix.ai"

# With per_page limit
curl -s "https://api.openalex.org/works?search=CRISPR+gene+editing&per_page=10&mailto=agent@kortix.ai"
```

### Boolean Search

Use uppercase `AND`, `OR`, `NOT` with parentheses and quoted phrases:

```bash
# Complex boolean query
curl -s "https://api.openalex.org/works?search=(reinforcement+learning+AND+%22robot+control%22)+NOT+simulation&mailto=agent@kortix.ai"

# Exact phrase match (use double quotes, URL-encoded as %22)
curl -s "https://api.openalex.org/works?search=%22attention+is+all+you+need%22&mailto=agent@kortix.ai"
```

### Search Specific Fields

```bash
# Title only
curl -s "https://api.openalex.org/works?filter=title.search:transformer&mailto=agent@kortix.ai"

# Abstract only
curl -s "https://api.openalex.org/works?filter=abstract.search:protein+folding&mailto=agent@kortix.ai"

# Title and abstract combined
curl -s "https://api.openalex.org/works?filter=title_and_abstract.search:neural+scaling+laws&mailto=agent@kortix.ai"

# Fulltext search (subset of works)
curl -s "https://api.openalex.org/works?filter=fulltext.search:climate+tipping+points&mailto=agent@kortix.ai"
```

## Filtering

Filters are the most powerful feature. Combine them with commas (AND) or pipes (OR).

### Most Useful Filters

```bash
# By publication year
?filter=publication_year:2024
?filter=publication_year:2020-2024
?filter=publication_year:>2022

# By citation count
?filter=cited_by_count:>100        # highly cited
?filter=cited_by_count:>1000       # landmark papers

# By open access
?filter=is_oa:true                 # only open access
?filter=oa_status:gold             # gold OA only

# By type
?filter=type:article               # journal articles
?filter=type:preprint              # preprints
?filter=type:review                # review articles

# By language
?filter=language:en                # English only

# Not retracted
?filter=is_retracted:false

# Has abstract
?filter=has_abstract:true

# Has downloadable PDF
?filter=has_content.pdf:true

# By author (OpenAlex ID)
?filter=author.id:A5023888391

# By institution (OpenAlex ID)
?filter=institutions.id:I27837315  # e.g., University of Michigan

# By DOI
?filter=doi:https://doi.org/10.1038/s41586-021-03819-2

# By indexed source
?filter=indexed_in:arxiv           # arXiv papers
?filter=indexed_in:pubmed          # PubMed papers
?filter=indexed_in:crossref        # Crossref papers
```

### Combining Filters

```bash
# AND: comma-separated
?filter=publication_year:>2022,cited_by_count:>50,is_oa:true,type:article

# OR: pipe-separated within a filter
?filter=publication_year:2023|2024

# NOT: prefix with !
?filter=type:!preprint

# Combined example: highly-cited OA articles from 2023-2024, not preprints
curl -s "https://api.openalex.org/works?filter=publication_year:2023-2024,cited_by_count:>50,is_oa:true,type:!preprint&search=machine+learning&per_page=10&mailto=agent@kortix.ai"
```

## Sorting

```bash
# Most cited first
?sort=cited_by_count:desc

# Most recent first
?sort=publication_date:desc

# Most relevant first (only when using search)
?sort=relevance_score:desc

# Multiple sort keys
?sort=publication_year:desc,cited_by_count:desc
```

## Pagination

Two modes: **basic paging** (for browsing) and **cursor paging** (for collecting all results).

```bash
# Basic paging (limited to 10,000 results)
?page=1&per_page=25
?page=2&per_page=25

# Cursor paging (unlimited, for collecting everything)
?per_page=100&cursor=*                    # first page
?per_page=100&cursor=IlsxNjk0ODc...      # next page (cursor from previous response meta)
```

The cursor for the next page is in `response.meta.next_cursor`. When it's `null`, you've reached the end.

## Select Fields

Reduce response size by selecting only the fields you need:

```bash
# Only get IDs, titles, citation counts, and DOIs
?select=id,display_name,cited_by_count,doi,publication_year

# Minimal metadata for scanning
?select=id,display_name,publication_year,cited_by_count,open_access
```

## Citation Graph Traversal

### Find what a paper cites (outgoing references)

```bash
# Get works cited BY a specific paper
curl -s "https://api.openalex.org/works?filter=cited_by:W2741809807&per_page=25&mailto=agent@kortix.ai"
```

### Find what cites a paper (incoming citations)

```bash
# Get works that CITE a specific paper
curl -s "https://api.openalex.org/works?filter=cites:W2741809807&sort=cited_by_count:desc&per_page=25&mailto=agent@kortix.ai"
```

### Find related works

```bash
# Get related works (algorithmic, based on shared concepts)
curl -s "https://api.openalex.org/works?filter=related_to:W2741809807&per_page=25&mailto=agent@kortix.ai"
```

### Citation chain: follow the references

1. Get a seminal paper by DOI
2. Find its `referenced_works` (what it cites)
3. Find who cites it (`filter=cites:WORK_ID`)
4. For the most cited citers, repeat

This is how you build a literature graph around a topic.

## Author Lookup

```bash
# Search for an author
curl -s "https://api.openalex.org/authors?search=Yann+LeCun&mailto=agent@kortix.ai"

# Get an author's works (by OpenAlex author ID)
curl -s "https://api.openalex.org/works?filter=author.id:A5064850633&sort=cited_by_count:desc&per_page=10&mailto=agent@kortix.ai"

# Get an author by ORCID
curl -s "https://api.openalex.org/authors/orcid:0000-0001-6187-6610?mailto=agent@kortix.ai"
```

## Lookup by External ID

```bash
# By DOI
curl -s "https://api.openalex.org/works/doi:10.1038/s41586-021-03819-2?mailto=agent@kortix.ai"

# By PubMed ID
curl -s "https://api.openalex.org/works/pmid:14907713?mailto=agent@kortix.ai"

# By arXiv ID (via DOI)
curl -s "https://api.openalex.org/works/doi:10.48550/arXiv.2303.08774?mailto=agent@kortix.ai"

# Batch lookup: up to 50 IDs at once
curl -s "https://api.openalex.org/works?filter=doi:https://doi.org/10.1234/a|https://doi.org/10.1234/b|https://doi.org/10.1234/c&mailto=agent@kortix.ai"
```

## Open Access & PDF Access

```bash
# Find OA papers with direct PDF links
curl -s "https://api.openalex.org/works?search=quantum+computing&filter=is_oa:true,has_content.pdf:true&select=id,display_name,open_access,best_oa_location&per_page=5&mailto=agent@kortix.ai"
```

The `best_oa_location.pdf_url` field gives a direct PDF link when available. The `open_access.oa_url` gives the best available OA landing page or PDF.

## Practical Workflows

### Literature Survey on a Topic

```bash
# 1. Find the most-cited papers on a topic
curl -s "https://api.openalex.org/works?search=retrieval+augmented+generation&sort=cited_by_count:desc&filter=publication_year:>2020,type:article,has_abstract:true&per_page=20&select=id,display_name,publication_year,cited_by_count,doi,authorships,abstract_inverted_index&mailto=agent@kortix.ai"

# 2. For the top papers, explore their citation graphs
curl -s "https://api.openalex.org/works?filter=cites:W4285719527&sort=cited_by_count:desc&per_page=10&select=id,display_name,publication_year,cited_by_count,doi&mailto=agent@kortix.ai"

# 3. Find recent papers building on this work
curl -s "https://api.openalex.org/works?filter=cites:W4285719527,publication_year:>2023&sort=publication_date:desc&per_page=10&mailto=agent@kortix.ai"
```

### Find Landmark/Seminal Papers

```bash
# Highly cited + search term
curl -s "https://api.openalex.org/works?search=attention+mechanism+neural+networks&filter=cited_by_count:>500,type:article&sort=cited_by_count:desc&per_page=10&select=id,display_name,publication_year,cited_by_count,doi&mailto=agent@kortix.ai"
```

### Find Recent Preprints

```bash
# Latest preprints on a topic
curl -s "https://api.openalex.org/works?search=multimodal+large+language+models&filter=type:preprint,publication_year:2025&sort=publication_date:desc&per_page=15&mailto=agent@kortix.ai"
```

### Find Review Articles

```bash
# Review/survey papers on a topic
curl -s "https://api.openalex.org/works?search=federated+learning&filter=type:review,cited_by_count:>20&sort=cited_by_count:desc&per_page=10&mailto=agent@kortix.ai"
```

### Author Analysis

```bash
# 1. Find the author
curl -s "https://api.openalex.org/authors?search=Geoffrey+Hinton&select=id,display_name,works_count,cited_by_count,last_known_institutions&mailto=agent@kortix.ai"

# 2. Get their most influential papers
curl -s "https://api.openalex.org/works?filter=author.id:A5068082743&sort=cited_by_count:desc&per_page=10&select=id,display_name,publication_year,cited_by_count,doi&mailto=agent@kortix.ai"

# 3. Get their recent work
curl -s "https://api.openalex.org/works?filter=author.id:A5068082743,publication_year:>2023&sort=publication_date:desc&per_page=10&mailto=agent@kortix.ai"
```

## Saving Results to Disk

When doing deep research, save paper data to disk for later processing:

```bash
# Save search results as JSON
curl -s "https://api.openalex.org/works?search=topic&per_page=50&mailto=agent@kortix.ai" > research/papers/topic-search.json

# Extract and save a clean summary
curl -s "https://api.openalex.org/works?search=topic&per_page=50&select=id,display_name,publication_year,cited_by_count,doi,authorships&mailto=agent@kortix.ai" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for w in data.get('results', []):
    authors = ', '.join(a['author']['display_name'] for a in w.get('authorships', [])[:3])
    if len(w.get('authorships', [])) > 3: authors += ' et al.'
    print(f\"[{w.get('cited_by_count',0)} cites] {w['display_name']} ({w.get('publication_year','?')}) - {authors}\")
    if w.get('doi'): print(f\"  DOI: {w['doi']}\")
    print()
" > research/papers/topic-summary.txt
```

For deep research, save individual paper metadata to your `sources-index.md` and raw data to `sources/`:

```bash
# Save a paper's full metadata
curl -s "https://api.openalex.org/works/W2741809807?mailto=agent@kortix.ai" > research/sources/001-paper-title.json
```

## Rate Limits

| Pool | Rate | How to get it |
|------|------|---------------|
| Common | 1 req/sec | No email provided |
| Polite | 10 req/sec | Add `mailto=your@email.com` to requests |
| Premium | Higher | Paid API key via `api_key` param |

**Always use the polite pool.** Add `&mailto=agent@kortix.ai` to every request.

## Tips

- **Use `select` aggressively** to reduce response size and speed up requests
- **Use `per_page=100`** (max) when collecting lots of results to minimize request count
- **Use cursor paging** (`cursor=*`) when you need more than 10,000 results
- **Batch DOI lookups** with OR syntax: `filter=doi:DOI1|DOI2|DOI3` (up to 50)
- **Reconstruct abstracts** using the inverted index -- don't skip this, abstracts are gold
- **Follow citation chains** to find seminal works and recent developments
- **Filter by `has_abstract:true`** when you need abstracts (not all works have them)
- **Filter by `indexed_in:arxiv`** or `indexed_in:pubmed` to target specific repositories
- **Sort by `cited_by_count:desc`** to find the most influential papers first
- **Combine search + filters** for precise results: search gives relevance, filters give precision
