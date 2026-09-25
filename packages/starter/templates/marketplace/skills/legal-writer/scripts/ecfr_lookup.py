#!/usr/bin/env python3
"""eCFR and Federal Register API client for statute/regulation lookup.

Look up federal regulations from the Code of Federal Regulations (eCFR)
and federal statutes. No API key required.

Usage:
    # Search eCFR for regulations
    python3 ecfr_lookup.py search "data privacy" --title 16
    python3 ecfr_lookup.py search "employment discrimination"

    # Get a specific CFR section
    python3 ecfr_lookup.py section 16 444     # 16 C.F.R. § 444
    python3 ecfr_lookup.py section 47 73.609  # 47 C.F.R. § 73.609

    # Get CFR title structure (table of contents)
    python3 ecfr_lookup.py toc 16             # Title 16 structure

    # Search Federal Register (proposed rules, final rules)
    python3 ecfr_lookup.py fedreg "artificial intelligence"

APIs used:
    eCFR: https://www.ecfr.gov/api/versioner/v1/
    Federal Register: https://www.federalregister.gov/api/v1/

No authentication required for either API.
"""

import sys
import json
import re as _re
import urllib.request
import urllib.parse
import urllib.error
from datetime import date

ECFR_SEARCH_BASE = "https://www.ecfr.gov/api/search/v1"
ECFR_VERSIONER_BASE = "https://www.ecfr.gov/api/versioner/v1"
FEDREG_BASE = "https://www.federalregister.gov/api/v1"

# Cache for latest available date per title
_title_dates = {}


def api_get(url, params=None, accept="application/json"):
    """Make a GET request."""
    if params:
        url += "?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(url, headers={"Accept": accept})
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read()
            content_type = resp.headers.get("Content-Type", "")
            if "json" in content_type or accept == "application/json":
                try:
                    return json.loads(body)
                except json.JSONDecodeError:
                    return {"raw": body.decode("utf-8", errors="replace")[:5000]}
            return {"raw": body.decode("utf-8", errors="replace")[:5000]}
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        print(json.dumps({
            "error": f"HTTP {e.code}: {e.reason}",
            "detail": error_body[:500],
            "url": url
        }), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


def get_latest_date(title_num):
    """Get the latest available date for a CFR title from the versioner API.

    The eCFR versioner API requires a date <= the title's up_to_date_as_of.
    Returns the up_to_date_as_of date string (YYYY-MM-DD).
    """
    title_num = str(title_num)
    if title_num in _title_dates:
        return _title_dates[title_num]

    data = api_get(f"{ECFR_VERSIONER_BASE}/titles.json")
    titles = data.get("titles", data) if isinstance(data, dict) else data
    for t in titles:
        num = str(t.get("number", ""))
        d = t.get("up_to_date_as_of", "")
        if d:
            _title_dates[num] = d

    return _title_dates.get(title_num, date.today().isoformat())


def search_ecfr(query, title=None):
    """Search the eCFR for regulations matching a query.

    The eCFR search API uses full-text search across all CFR titles.
    """
    url = f"{ECFR_SEARCH_BASE}/results"
    params = {
        "query": query,
        "per_page": 10,
        "page": 1,
    }
    if title:
        params["hierarchy[title]"] = title

    data = api_get(url, params)

    results = []
    for r in data.get("results", []):
        hierarchy = r.get("hierarchy", {})
        headings = r.get("headings", {})
        # Strip HTML tags from excerpts
        snippet = _re.sub(r'<[^>]+>', '', r.get("full_text_excerpt", "") or "")
        heading_text = _re.sub(r'<[^>]+>', '', headings.get("section", "") or headings.get("part", "") or "")
        title_num = hierarchy.get("title", "")
        section_num = hierarchy.get("section", "")
        results.append({
            "title": title_num,
            "part": hierarchy.get("part", ""),
            "section": section_num,
            "heading": heading_text,
            "snippet": snippet[:400],
            "cfr_citation": f"{title_num} C.F.R. § {section_num}" if section_num else "",
            "hierarchy": hierarchy,
        })

    return {
        "count": data.get("meta", {}).get("total_count", len(results)),
        "query": query,
        "results": results,
    }


def get_section(title, section):
    """Get a specific CFR section's full text.

    Args:
        title: CFR title number (e.g., 16)
        section: Section number (e.g., "444.1" or "73.609")
    """
    as_of = get_latest_date(title)
    # Parse section into part and section
    parts = str(section).split(".")
    part = parts[0]

    # The full endpoint returns XML; request it and extract text
    url = f"{ECFR_VERSIONER_BASE}/full/{as_of}/title-{title}.xml"
    params = {"part": part}
    if len(parts) > 1:
        params["section"] = section

    data = api_get(url, params, accept="application/xml")

    # Extract text from XML/raw response
    raw = data.get("raw", "") if isinstance(data, dict) else str(data)
    # Strip XML tags for readable output
    text = _re.sub(r'<[^>]+>', ' ', raw)
    text = _re.sub(r'\s+', ' ', text).strip()

    return {
        "citation": f"{title} C.F.R. § {section}",
        "title_number": title,
        "section_number": section,
        "as_of_date": as_of,
        "content": text[:3000],
    }


def get_toc(title):
    """Get table of contents for a CFR title."""
    as_of = get_latest_date(title)
    url = f"{ECFR_VERSIONER_BASE}/structure/{as_of}/title-{title}.json"
    data = api_get(url)

    # Flatten structure for readability
    def flatten(node, depth=0):
        results = []
        label = node.get("label", "") or node.get("identifier", "")
        label_desc = node.get("label_description", "") or node.get("reserved", "")
        if label:
            prefix = "  " * depth
            results.append(f"{prefix}{label}: {label_desc}")
        for child in node.get("children", []):
            results.extend(flatten(child, depth + 1))
        return results

    lines = flatten(data)
    return {
        "title": title,
        "structure": lines[:100],  # Limit output
        "truncated": len(lines) > 100,
    }


def search_federal_register(query, doc_type=None):
    """Search the Federal Register for rules, proposed rules, and notices.

    Args:
        query: Search terms
        doc_type: "RULE" | "PRORULE" | "NOTICE" | "PRESDOCU" (optional)
    """
    url = f"{FEDREG_BASE}/documents.json"
    params = {
        "conditions[term]": query,
        "per_page": 10,
        "order": "relevance",
    }
    if doc_type:
        params["conditions[type][]"] = doc_type

    data = api_get(url, params)

    results = []
    for r in data.get("results", []):
        results.append({
            "title": r.get("title", ""),
            "type": r.get("type", ""),
            "document_number": r.get("document_number", ""),
            "publication_date": r.get("publication_date", ""),
            "agencies": [a.get("name", "") for a in r.get("agencies", [])],
            "abstract": (r.get("abstract", "") or "")[:300],
            "citation": r.get("citation", ""),
            "pdf_url": r.get("pdf_url", ""),
            "html_url": r.get("html_url", ""),
            "fr_citation": f"{r.get('volume', '')} Fed. Reg. {r.get('start_page', '')} ({r.get('publication_date', '')})"
                          if r.get("volume") else "",
        })

    return {
        "count": data.get("count", len(results)),
        "query": query,
        "results": results,
    }


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  ecfr_lookup.py search <query> [--title <n>]", file=sys.stderr)
        print("  ecfr_lookup.py section <title> <section>", file=sys.stderr)
        print("  ecfr_lookup.py toc <title>", file=sys.stderr)
        print("  ecfr_lookup.py fedreg <query> [--type RULE|PRORULE|NOTICE]", file=sys.stderr)
        sys.exit(1)

    command = sys.argv[1]

    if command == "search":
        if len(sys.argv) < 3:
            print("Usage: ecfr_lookup.py search <query> [--title <n>]", file=sys.stderr)
            sys.exit(1)
        query = sys.argv[2]
        title = None
        if "--title" in sys.argv:
            idx = sys.argv.index("--title")
            title = int(sys.argv[idx + 1])
        result = search_ecfr(query, title=title)
        print(json.dumps(result, indent=2))

    elif command == "section":
        if len(sys.argv) < 4:
            print("Usage: ecfr_lookup.py section <title> <section>", file=sys.stderr)
            sys.exit(1)
        title = sys.argv[2]
        section = sys.argv[3]
        result = get_section(title, section)
        print(json.dumps(result, indent=2))

    elif command == "toc":
        if len(sys.argv) < 3:
            print("Usage: ecfr_lookup.py toc <title>", file=sys.stderr)
            sys.exit(1)
        title = sys.argv[2]
        result = get_toc(title)
        print(json.dumps(result, indent=2))

    elif command == "fedreg":
        if len(sys.argv) < 3:
            print("Usage: ecfr_lookup.py fedreg <query>", file=sys.stderr)
            sys.exit(1)
        query = sys.argv[2]
        doc_type = None
        if "--type" in sys.argv:
            idx = sys.argv.index("--type")
            doc_type = sys.argv[idx + 1]
        result = search_federal_register(query, doc_type=doc_type)
        print(json.dumps(result, indent=2))

    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
