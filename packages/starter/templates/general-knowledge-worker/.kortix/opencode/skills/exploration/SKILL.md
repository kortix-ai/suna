---
name: exploration
description: "Systematic methodology for profiling datasets, assessing data quality, discovering patterns, and understanding schemas."
defaultProjectInstall: true
---

# Data Exploration Skill

Systematic methodology for profiling datasets, assessing data quality, discovering patterns, and understanding schemas.

## Data Profiling Methodology

### Phase 1: Structural Understanding

Before analyzing any data, understand its structure:

**Table-level questions:**
- How many rows and columns?
- What is the grain (one row per what)?
- What is the primary key? Is it unique?
- When was the data last updated?
- How far back does the data go?

**Column classification:**
Categorize each column as one of:
- **Identifier**: Unique keys, foreign keys, entity IDs
- **Dimension**: Categorical attributes for grouping/filtering (status, type, region, category)
- **Metric**: Quantitative values for measurement (revenue, count, duration, score)
- **Temporal**: Dates and timestamps (created_at, updated_at, event_date)
- **Text**: Free-form text fields (description, notes, name)
- **Boolean**: True/false flags
- **Structural**: JSON, arrays, nested structures

### Phase 2: Column-Level Profiling

For each column, compute:

**All columns:**
- Null count and null rate
- Distinct count and cardinality ratio (distinct / total)
- Most common values (top 5-10 with frequencies)
- Least common values (bottom 5 to spot anomalies)

**Numeric columns (metrics):**
```
min, max, mean, median (p50)
standard deviation
percentiles: p1, p5, p25, p75, p95, p99
zero count
negative count (if unexpected)
```

**String columns (dimensions, text):**
```
min length, max length, avg length
empty string count
pattern analysis (do values follow a format?)
case consistency (all upper, all lower, mixed?)
leading/trailing whitespace count
```

**Date/timestamp columns:**
```
min date, max date
null dates
future dates (if unexpected)
distribution by month/week
gaps in time series
```

**Boolean columns:**
```
true count, false count, null count
true rate
```

### Phase 3: Relationship Discovery

After profiling individual columns:

- **Foreign key candidates**: ID columns that might link to other tables
- **Hierarchies**: Columns that form natural drill-down paths (country > state > city)
- **Correlations**: Numeric columns that move together
- **Derived columns**: Columns that appear to be computed from others
- **Redundant columns**: Columns with identical or near-identical information

## Quality Assessment Framework

### Completeness Score

Rate each column:
- **Complete** (>99% non-null): Green
- **Mostly complete** (95-99%): Yellow -- investigate the nulls
- **Incomplete** (80-95%): Orange -- understand why and whether it matters
- **Sparse** (<80%): Red -- may not be usable without imputation

### Consistency Checks

Look for:
- **Value format inconsistency**: Same concept represented differently ("USA", "US", "United States", "us")
- **Type inconsistency**: Numbers stored as strings, dates in various formats
- **Referential integrity**: Foreign keys that don't match any parent record
- **Business rule violations**: Negative quantities, end dates before start dates, percentages > 100
- **Cross-column consistency**: Status = "completed" but completed_at is null

### Accuracy Indicators

Red flags that suggest accuracy issues:
- **Placeholder values**: 0, -1, 999999, "N/A", "TBD", "test", "xxx"
- **Default values**: Suspiciously high frequency of a single value
- **Stale data**: Updated_at shows no recent changes in an active system
- **Impossible values**: Ages > 150, dates in the far future, negative durations
- **Round number bias**: All values ending in 0 or 5 (suggests estimation, not measurement)

### Timeliness Assessment

- When was the table last updated?
- What is the expected update frequency?
- Is there a lag between event time and load time?
- Are there gaps in the time series?

## Pattern Discovery Techniques

### Distribution Analysis

For numeric columns, characterize the distribution:
- **Normal**: Mean and median are close, bell-shaped
- **Skewed right**: Long tail of high values (common for revenue, session duration)
- **Skewed left**: Long tail of low values (less common)
- **Bimodal**: Two peaks (suggests two distinct populations)
- **Power law**: Few very large values, many small ones (common for user activity)
- **Uniform**: Roughly equal frequency across range (often synthetic or random)

### Temporal Patterns

For time series data, look for:
- **Trend**: Sustained upward or downward movement
- **Seasonality**: Repeating patterns (weekly, monthly, quarterly, annual)
- **Day-of-week effects**: Weekday vs. weekend differences
- **Holiday effects**: Drops or spikes around known holidays
- **Change points**: Sudden shifts in level or trend
- **Anomalies**: Individual data points that break the pattern

### Segmentation Discovery

Identify natural segments by:
- Finding categorical columns with 3-20 distinct values
- Comparing metric distributions across segment values
- Looking for segments with significantly different behavior
- Testing whether segments are homogeneous or contain sub-segments

### Correlation Exploration

Between numeric columns:
- Compute correlation matrix for all metric pairs
- Flag strong correlations (|r| > 0.7) for investigation
- Note: Correlation does not imply causation -- flag this explicitly
- Check for non-linear relationships (e.g., quadratic, logarithmic)

## Schema Understanding and Documentation

### Schema Documentation Template

When documenting a dataset for team use:

```markdown
## Table: [schema.table_name]

**Description**: [What this table represents]
**Grain**: [One row per...]
**Primary Key**: [column(s)]
**Row Count**: [approximate, with date]
**Update Frequency**: [real-time / hourly / daily / weekly]
**Owner**: [team or person responsible]

### Key Columns

| Column | Type | Description | Example Values | Notes |
|--------|------|-------------|----------------|-------|
| user_id | STRING | Unique user identifier | "usr_abc123" | FK to users.id |
| event_type | STRING | Type of event | "click", "view", "purchase" | 15 distinct values |
| revenue | DECIMAL | Transaction revenue in USD | 29.99, 149.00 | Null for non-purchase events |
| created_at | TIMESTAMP | When the event occurred | 2024-01-15 14:23:01 | Partitioned on this column |

### Relationships
- Joins to `users` on `user_id`
- Joins to `products` on `product_id`
- Parent of `event_details` (1:many on event_id)

### Known Issues
- [List any known data quality issues]
- [Note any gotchas for analysts]

### Common Query Patterns
- [Typical use cases for this table]
```

### Schema Exploration Queries

When connected to a data warehouse, use these patterns to discover schema:

```sql
-- List all tables in a schema (PostgreSQL)
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

-- Column details (PostgreSQL)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'my_table'
ORDER BY ordinal_position;

-- Table sizes (PostgreSQL)
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- Row counts for all tables (general pattern)
-- Run per-table: SELECT COUNT(*) FROM table_name
```

### Lineage and Dependencies

When exploring an unfamiliar data environment:

1. Start with the "output" tables (what reports or dashboards consume)
2. Trace upstream: What tables feed into them?
3. Identify raw/staging/mart layers
4. Map the transformation chain from raw data to analytical tables
5. Note where data is enriched, filtered, or aggregated

## Pre-Delivery QA Checklist

Profiling and understanding a dataset is only half the job — before sharing any analysis built on it, run this checklist. It catches the errors that clean profiling doesn't: bad joins, wrong denominators, and results that don't actually mean what they appear to mean.

### Data Quality Checks
- [ ] **Source verification**: Confirmed which tables/data sources were used, and that they're the right ones for this question.
- [ ] **Freshness**: Data is current enough for the analysis. Noted the "as of" date.
- [ ] **Completeness**: No unexpected gaps in time series or missing segments.
- [ ] **Null handling**: Checked null rates in key columns; nulls are excluded, imputed, or flagged appropriately.
- [ ] **Deduplication**: No double-counting from bad joins or duplicate source records.
- [ ] **Filter verification**: All WHERE clauses and filters are correct — no unintended exclusions.

### Calculation Checks
- [ ] **Aggregation logic**: GROUP BY includes all non-aggregated columns; aggregation level matches the analysis grain.
- [ ] **Denominator correctness**: Rate/percentage calculations use the right, non-zero denominator.
- [ ] **Date alignment**: Comparisons use equal-length periods; partial periods are excluded or noted.
- [ ] **Join correctness**: JOIN types are appropriate (INNER vs LEFT); many-to-many joins haven't inflated counts.
- [ ] **Metric definitions**: Match how stakeholders define them; deviations are noted.
- [ ] **Subtotals sum**: Parts add up to the whole where expected — explain any overlap that breaks this.

### Reasonableness Checks
- [ ] **Magnitude**: Numbers are in a plausible range (no negative revenue, percentages within 0-100%).
- [ ] **Trend continuity**: No unexplained jumps or drops in time series.
- [ ] **Cross-reference**: Key numbers match other known sources (dashboards, prior reports, finance data).
- [ ] **Edge cases**: Checked boundaries — empty segments, zero-activity periods, new entities.

### Presentation Checks
- [ ] **Chart accuracy**: Bar charts start at zero; axes labeled; scales consistent across panels.
- [ ] **Number formatting**: Appropriate precision, consistent currency/percentage formatting.
- [ ] **Caveat transparency**: Known limitations and assumptions are stated explicitly.
- [ ] **Reproducibility**: Someone else could recreate this analysis from the documentation provided.

### Common Pitfalls to Rule Out

- **Join explosion**: a many-to-many join silently multiplies rows. Check row counts before and after every join; use `COUNT(DISTINCT id)` rather than `COUNT(*)` through joins.
- **Survivorship bias**: analyzing only entities that exist today misses churned/deleted/failed ones. Ask "who is NOT in this dataset?"
- **Incomplete period comparison**: comparing a partial period to a full one (e.g. mid-month vs. last full month). Always compare complete, equal-length periods.
- **Denominator shifting**: the denominator's definition changes between compared periods, making rates incomparable.
- **Average of averages**: averaging pre-computed averages gives the wrong answer when group sizes differ — always aggregate from raw data, or use a weighted average.
- **Timezone mismatches**: standardize all timestamps to one timezone (UTC recommended) before comparing sources.
- **Selection bias in segmentation**: segments defined by the outcome being measured create circular logic (e.g. "users who finished onboarding retain better" — of course they do).

### Result Sanity Checking

For every key number, run it through a smell test: does it match known MAU/DAU, is revenue in the right order of magnitude vs. known ARR, are conversion rates between 0-100% and consistent with dashboards, is 50%+ MoM growth actually plausible. Cross-validate by calculating the same metric two different ways, spot-checking a few individual records by hand, comparing to a known benchmark, and reverse-engineering (does per-unit x count ≈ the total?).

**Red flags that warrant investigation before delivery:** any metric that moved >50% period-over-period without an obvious cause; suspiciously round totals; rates sitting exactly at 0% or 100%; results that perfectly confirm the hypothesis (reality is usually messier); identical values across periods or segments (often means a dimension is being ignored by the query).

### Documentation Standards for Reproducibility

Every non-trivial analysis should record: the question being answered, data sources with "as of" dates, exact metric/segment/time-period definitions, methodology steps, assumptions and limitations, key findings with supporting evidence, the queries used, and caveats the reader needs before acting on it. Save queries/code in version control or a shared docs system, note the data snapshot date, and link prior versions of recurring analyses for trend comparison.