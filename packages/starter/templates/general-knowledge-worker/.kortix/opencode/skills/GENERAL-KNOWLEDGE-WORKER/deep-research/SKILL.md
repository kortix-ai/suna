---
name: deep-research
description: "Deep research agent skill. Use when the user needs thorough, scientific, truth-seeking research on any topic -- investigating claims, finding primary sources, synthesizing evidence, producing cited reports. Triggers on: 'research this', 'investigate', 'deep dive', 'find sources', 'what does the evidence say', 'literature review', 'fact check', 'analyze the research on', any request requiring multi-source investigation with citations."
---

# Deep Research

Systematic, evidence-based research that produces cited, source-backed reports. Uses the **filesystem as working memory** -- scraped content, extracted notes, and source metadata are saved to disk rather than held in context. This keeps the context window lean and makes research resumable, searchable, and reusable.

## Architecture

```
research/{topic-slug}/
  plan.md                    # Research plan with sub-questions
  sources-index.md           # URL registry: what's been scraped, metadata
  sources/                   # Raw scraped content (one file per source)
    001-source-slug.md
    002-source-slug.md
    ...
  notes/                     # Extracted findings per sub-question
    question-1.md
    question-2.md
    ...
  report.md                  # Final compiled report
```

**Core principle:** Write to disk aggressively, read back selectively. Never hold raw scraped content in context longer than it takes to extract findings. The LLM context should contain only the current working set -- not the entire research corpus.

## Research Parameters

- **Breadth** (default: 3): Parallel search queries per sub-question. Range: 2-6.
- **Depth** (default: 2): Recursive deepening rounds. Range: 1-4.

Estimate: breadth=3, depth=2 -> ~12-20 web searches, ~8-15 pages read, 3-8 minute runtime.

For quick fact-checks: breadth=2, depth=1.
For exhaustive reviews: breadth=5, depth=3.

## Step-by-Step Workflow

### Phase 0: Initialize

1. **Create the research directory:**
   ```bash
   mkdir -p research/{topic-slug}/sources research/{topic-slug}/notes
   ```

2. **Search local filesystem first.** Before any web search, check if relevant content already exists:
   - Past research in `research/` directories in the working directory
   - Relevant files in the working directory or project
    - Use `grep`, `glob`, or semantic search (`lss`) as appropriate for the task
   - If prior research exists on this topic, read it and build on it -- don't start from scratch

3. **Initialize `sources-index.md`:**
   ```markdown
   # Sources Index

   | # | URL | Title | Date | Type | Credibility | File |
   |---|-----|-------|------|------|-------------|------|
   ```

### Phase 1: Planning

1. Analyze the query. Identify:
   - Core research question(s)
   - Required evidence types (empirical data, expert opinion, primary sources, statistics)
   - Potential biases to watch for

2. Decompose into 2-5 independently researchable sub-questions.

3. Write `plan.md` with the sub-questions, search strategy, and scope decisions.

4. Create a todo list tracking each sub-question.

### Phase 2: Search-Read-Extract Loop

For each sub-question, execute this loop:

#### 2a. Generate Search Queries

Generate `breadth` distinct queries. Vary:
- Phrasing (synonyms, technical vs. lay terms)
- Angle (supporting evidence, counter-evidence, meta-analyses)
- Source type (academic `site:scholar.google.com`, government `site:gov`, news, industry)
- Recency (add year filters for time-sensitive topics)

**Batch search with `search_depth: "advanced"`:**
```
web_search("query1 ||| query2 ||| query3", search_depth="advanced")
```

#### 2b. Read and Extract

For each promising search result:

1. **Check `sources-index.md` first.** If the URL is already scraped, skip it. Do not re-scrape pages already processed in this session.

2. **Scrape the page.** Batch URLs for efficiency:
   ```
   scrape_webpage("url1, url2, url3")
   ```

3. **Save raw content to disk immediately:**
   ```bash
   # Write scraped content to sources/NNN-slug.md
   ```
   Include a header with the URL, title, and scrape date. This gets the raw content out of your context.

4. **Extract key findings** from the scraped content and append to `notes/question-N.md`:
   - Key claims and findings (with brief quotes when important)
   - Data points: numbers, statistics, dates
   - The source number (for citation mapping later)
   - Methodology notes if relevant (sample size, study design)

5. **Update `sources-index.md`** with the new source entry:
   ```
   | 003 | https://example.com/article | Article Title | 2025-06-15 | news | medium | sources/003-article-title.md |
   ```

6. **Free your context.** After extracting findings and saving to disk, you do not need to retain the raw scraped content. Move on to the next source.

#### 2c. Deepen (Recursive)

After processing results for a sub-question:

1. **Read `notes/question-N.md`** to assess coverage.
2. Identify gaps: what remains unanswered? What claims lack corroboration?
3. Generate follow-up questions based on findings.
4. If `depth > 0`: recurse with follow-up questions at `depth - 1` and `ceil(breadth / 2)`.
5. If `depth == 0`: stop, move to next sub-question.

### Phase 3: Synthesis

After all sub-questions are researched:

1. **Read all `notes/*.md` files** (not raw sources -- the notes are already distilled).
2. **Cross-reference claims** -- flag where sources agree vs. contradict.
3. **Resolve contradictions** by source quality:
   - Peer-reviewed > government data > industry reports > news > blogs
   - Meta-analyses > individual studies
   - Multiple independent sources > single source
4. **Identify consensus vs. uncertainty.** Be explicit about what is well-established vs. debated vs. unknown.
5. **Check for bias:** Did search results skew toward one viewpoint? Are key perspectives missing?

### Phase 4: Report Generation

Compile `report.md` using findings from notes and metadata from `sources-index.md`.

```markdown
# [Research Title]

## Executive Summary
[2-3 paragraph overview of key findings and conclusions]

## Key Findings

### [Finding 1 Title]
[Discussion with inline citations [1][2]]

### [Finding 2 Title]
[Discussion with inline citations [3][4]]

## Analysis
[Cross-cutting patterns, contradictions, consensus areas]

## Limitations & Caveats
[What this research couldn't determine, methodological limitations]

## Conclusions
[Evidence-based conclusions with confidence levels]

## Sources

[1] Author (Date). "Title." *Publication*. URL
[2] Author (Date). "Title." *Publication*. URL
```

**Build citations from `sources-index.md`** at report time. During the search phase, you only needed to track `{url, title, source_number}`. Now format the full bibliography by reading back source metadata from the index and source files as needed.

### Phase 5: Finalize

1. Save `report.md` in the research directory.
2. Report to user: main conclusions (2-3 sentences), number of sources, confidence levels, file path.

## Citation Rules

1. **Every factual claim must have a citation.** No uncited assertions of fact.
2. **Use numbered inline citations** `[1]`, `[2]` that map to the Sources section.
3. **Never fabricate sources.** Every URL in Sources must be a real page you actually visited and read.
4. **Quote directly** when the exact wording matters. Use `> blockquote` for direct quotes.
5. **Distinguish levels of evidence:**
   - "Studies show..." (cite the studies)
   - "According to [Source]..." (single source, acknowledge it)
   - "The evidence suggests..." (multiple corroborating sources)
   - "It remains debated whether..." (conflicting evidence)
6. **Date every source.** If no date is found, write "(n.d.)".
7. **Note source type** in the bibliography: academic paper, government report, news article, blog post, etc.

## Scientific Rigor Standards

- **Falsifiability:** Actively search for counter-evidence. Don't just confirm priors.
- **Replication:** A claim supported by multiple independent sources is stronger than one from a single source.
- **Recency awareness:** Newer isn't always better. Note when older foundational work is more relevant.
- **Correlation vs. causation:** Flag when sources conflate the two.
- **Sample size and methodology:** Note these for empirical claims.
- **Conflicts of interest:** Note when a source has a stake in its conclusions.

## Tool Usage Patterns

### Search (always use search_depth "advanced" for deep research)
```
web_search("topic aspect1 ||| topic aspect2 ||| topic counter-evidence", search_depth="advanced")
```

### Scrape (batch URLs)
```
scrape_webpage("https://source1.com/article, https://source2.com/study")
```

### Save scraped content to disk
```bash
# After scraping, immediately write to file and extract findings
# This is critical -- do not hold raw scraped content in context
```

### Academic Paper Search (OpenAlex)

Load the `openalex-paper-search` skill for full API reference. Quick patterns:

```bash
# Find highly-cited papers on a topic
curl -s "https://api.openalex.org/works?search=topic+keywords&filter=cited_by_count:>50,type:article,has_abstract:true&sort=cited_by_count:desc&per_page=15&select=id,display_name,publication_year,cited_by_count,doi,authorships,abstract_inverted_index&mailto=agent@kortix.ai"

# Find recent preprints
curl -s "https://api.openalex.org/works?search=topic&filter=type:preprint,publication_year:2025&sort=publication_date:desc&per_page=10&mailto=agent@kortix.ai"

# Find review/survey papers
curl -s "https://api.openalex.org/works?search=topic&filter=type:review,cited_by_count:>20&sort=cited_by_count:desc&per_page=10&mailto=agent@kortix.ai"

# Follow citation chains: who cites a seminal paper?
curl -s "https://api.openalex.org/works?filter=cites:WORK_ID&sort=cited_by_count:desc&per_page=10&mailto=agent@kortix.ai"
```

Save paper metadata to `sources-index.md` and raw API responses to `sources/` for later processing.

### Web Source Hunting
```
web_search("topic site:scholar.google.com ||| topic site:arxiv.org ||| topic systematic review OR meta-analysis", search_depth="advanced")
```

### Data Source Hunting
```
web_search("topic statistics site:data.gov ||| topic data site:worldbank.org ||| topic survey results", search_depth="advanced")
```

### Fact-Checking Pattern
```
web_search("claim fact check ||| claim evidence ||| claim debunked OR confirmed", search_depth="advanced")
```

### Local FS Search (check before web search)
```bash
# Search past research
grep -r "keyword" research/

# Semantic search if available
lss "research question" -p /workspace --json -k 10
```

## Handling Edge Cases

- **No good results found:** State what was searched and that evidence is lacking. This is a valid finding.
- **Highly technical topics:** Search for both technical papers and accessible explainers.
- **Rapidly evolving topics:** Prioritize recency. Note publication dates prominently.
- **Controversial topics:** Present all major viewpoints with evidence. Don't editorialize.
- **Paywalled sources:** Extract what's available from abstracts and secondary reporting. Note when full text was not accessible.
- **Resuming prior research:** If a research directory already exists, read the existing plan, notes, and sources-index. Continue from where the previous session left off rather than starting over.
