#!/usr/bin/env python3
"""CourtListener API client for case law lookup.

Search and retrieve case law from the Free Law Project's CourtListener database.
Millions of legal opinions across federal and state courts.

Usage:
    # Search for cases
    python3 courtlistener.py search "qualified immunity police"
    python3 courtlistener.py search "breach of contract damages" --court "scotus"
    python3 courtlistener.py search "first amendment speech" --after 2020

    # Get a specific opinion by ID
    python3 courtlistener.py opinion 12345

    # Get citation details
    python3 courtlistener.py cite 12345

    # Format a citation in Bluebook style
    python3 courtlistener.py bluebook 12345

API docs: https://www.courtlistener.com/api/rest/v4/
Auth: Set COURTLISTENER_API_TOKEN env var (free account at courtlistener.com)
      Without token: limited to 100 requests/day
      With token: 5,000 requests/day

Output: JSON to stdout (pipe to jq for formatting).
"""

import sys
import json
import os
import urllib.request
import urllib.parse
import urllib.error

BASE_URL = "https://www.courtlistener.com/api/rest/v4"

def get_headers():
    """Get auth headers if token is available."""
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("COURTLISTENER_API_TOKEN", "")
    if token:
        headers["Authorization"] = f"Token {token}"
    return headers


def api_get(endpoint, params=None):
    """Make a GET request to CourtListener API."""
    url = f"{BASE_URL}/{endpoint}/"
    if params:
        url += "?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(url, headers=get_headers())
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        print(json.dumps({
            "error": f"HTTP {e.code}: {e.reason}",
            "detail": error_body[:500],
            "url": url,
            "hint": "Get a free API token at https://www.courtlistener.com/sign-in/"
                    if e.code == 401 else ""
        }), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


def search_opinions(query, court=None, after=None, before=None, limit=10):
    """Search case law opinions.

    Args:
        query: Search terms
        court: Court filter (e.g., "scotus", "ca9", "nyed")
        after: Only cases after this year
        before: Only cases before this year
        limit: Max results (default 10)
    """
    params = {
        "type": "o",  # opinions
        "q": query,
        "page_size": min(limit, 20),
        "order_by": "score desc",
    }
    if court:
        params["court"] = court
    if after:
        params["filed_after"] = f"{after}-01-01"
    if before:
        params["filed_before"] = f"{before}-12-31"

    data = api_get("search", params)

    # Simplify results for easy consumption
    results = []
    for r in data.get("results", []):
        results.append({
            "id": r.get("cluster_id") or r.get("id"),
            "case_name": r.get("caseName", ""),
            "court": r.get("court", ""),
            "date_filed": r.get("dateFiled", ""),
            "citation": r.get("citation", []),
            "docket_number": r.get("docketNumber", ""),
            "snippet": (r.get("snippet", "") or "")[:300],
            "absolute_url": r.get("absolute_url", ""),
        })

    return {
        "count": data.get("count", 0),
        "results": results,
    }


def _search_by_id(cluster_id):
    """Look up a case by cluster_id via the search endpoint (no auth required)."""
    data = api_get("search", {"type": "o", "q": f"cluster_id:{cluster_id}", "page_size": 1})
    results = data.get("results", [])
    if not results:
        # Fallback: try the clusters endpoint (requires auth)
        try:
            return api_get(f"clusters/{cluster_id}")
        except SystemExit:
            print(json.dumps({"error": f"Case {cluster_id} not found"}), file=sys.stderr)
            sys.exit(1)
    r = results[0]
    return {
        "cluster_id": r.get("cluster_id") or cluster_id,
        "case_name": r.get("caseName", ""),
        "court": r.get("court", ""),
        "date_filed": r.get("dateFiled", ""),
        "citations": r.get("citation", []),
        "docket_number": r.get("docketNumber", ""),
        "snippet": (r.get("snippet", "") or "")[:500],
        "absolute_url": r.get("absolute_url", ""),
        "judge": r.get("judge", ""),
        "status": r.get("status", ""),
    }


def get_opinion(cluster_id):
    """Get a specific opinion cluster (case) by ID.

    Uses the search endpoint (no auth required) with cluster_id filter.
    """
    return _search_by_id(cluster_id)


def get_citations(cluster_id):
    """Get cases cited by a specific opinion.

    Note: This endpoint requires authentication (API token).
    """
    data = api_get("opinions-cited", {"citing_opinion__cluster__id": cluster_id})
    return data


# Map of court IDs to Bluebook abbreviations
COURT_ABBREVS = {
    "Supreme Court of the United States": "",  # No court abbrev needed for SCOTUS
    "scotus": "",
    # Federal Circuit Courts
    "Court of Appeals for the First Circuit": "1st Cir.",
    "Court of Appeals for the Second Circuit": "2d Cir.",
    "Court of Appeals for the Third Circuit": "3d Cir.",
    "Court of Appeals for the Fourth Circuit": "4th Cir.",
    "Court of Appeals for the Fifth Circuit": "5th Cir.",
    "Court of Appeals for the Sixth Circuit": "6th Cir.",
    "Court of Appeals for the Seventh Circuit": "7th Cir.",
    "Court of Appeals for the Eighth Circuit": "8th Cir.",
    "Court of Appeals for the Ninth Circuit": "9th Cir.",
    "Court of Appeals for the Tenth Circuit": "10th Cir.",
    "Court of Appeals for the Eleventh Circuit": "11th Cir.",
    "Court of Appeals for the D.C. Circuit": "D.C. Cir.",
    "Court of Appeals for the Federal Circuit": "Fed. Cir.",
}


def format_bluebook(cluster_id):
    """Attempt to format a case citation in Bluebook style.

    Uses the search endpoint (no auth required).
    Returns a best-effort Bluebook citation based on available data.
    Note: This is approximate — always verify against Bluebook rules.
    """
    data = _search_by_id(cluster_id)

    case_name = data.get("case_name", "Unknown Case")
    date_filed = data.get("date_filed", "")
    year = date_filed[:4] if date_filed else "n.d."

    citations = data.get("citations", [])
    court = data.get("court", "")

    # Get court abbreviation for Bluebook
    court_abbrev = COURT_ABBREVS.get(court, "")
    if not court_abbrev and court:
        # Try to extract a short form
        court_abbrev = court

    # Build citation — prefer official reporters
    # Priority: U.S. > S. Ct. > F.3d/F.4th > state reporters
    cite_str = ""
    for c in citations:
        if isinstance(c, str):
            # Check for preferred reporters
            if " U.S. " in c:
                cite_str = c
                break
            elif " S. Ct. " in c and not cite_str:
                cite_str = c
            elif (" F.3d " in c or " F.4th " in c or " F.2d " in c) and not cite_str:
                cite_str = c
            elif not cite_str:
                cite_str = c

    if cite_str:
        # For U.S. reports, no court abbreviation needed
        if " U.S. " in cite_str:
            return f"{case_name}, {cite_str} ({year})."
        else:
            court_part = f"{court_abbrev} " if court_abbrev else ""
            return f"{case_name}, {cite_str} ({court_part}{year})."
    else:
        court_part = f"{court_abbrev} " if court_abbrev else ""
        docket = data.get("docket_number", "unknown")
        return f"{case_name}, No. {docket} ({court_part}{year})."


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  courtlistener.py search <query> [--court <court>] [--after <year>] [--limit <n>]", file=sys.stderr)
        print("  courtlistener.py opinion <cluster_id>", file=sys.stderr)
        print("  courtlistener.py cite <cluster_id>", file=sys.stderr)
        print("  courtlistener.py bluebook <cluster_id>", file=sys.stderr)
        print("", file=sys.stderr)
        print("Courts: scotus, ca1-ca11, cadc, cafc, nyed, sdny, cdca, ...", file=sys.stderr)
        print("Auth: export COURTLISTENER_API_TOKEN=<your-token>", file=sys.stderr)
        sys.exit(1)

    command = sys.argv[1]

    if command == "search":
        if len(sys.argv) < 3:
            print("Usage: courtlistener.py search <query> [--court <c>] [--after <y>] [--limit <n>]", file=sys.stderr)
            sys.exit(1)
        query = sys.argv[2]
        court = None
        after = None
        limit = 10
        i = 3
        while i < len(sys.argv):
            if sys.argv[i] == "--court" and i + 1 < len(sys.argv):
                court = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--after" and i + 1 < len(sys.argv):
                after = int(sys.argv[i + 1]); i += 2
            elif sys.argv[i] == "--limit" and i + 1 < len(sys.argv):
                limit = int(sys.argv[i + 1]); i += 2
            else:
                i += 1
        result = search_opinions(query, court=court, after=after, limit=limit)
        print(json.dumps(result, indent=2))

    elif command == "opinion":
        cluster_id = sys.argv[2]
        result = get_opinion(cluster_id)
        print(json.dumps(result, indent=2))

    elif command == "cite":
        cluster_id = sys.argv[2]
        result = get_citations(cluster_id)
        print(json.dumps(result, indent=2))

    elif command == "bluebook":
        cluster_id = sys.argv[2]
        citation = format_bluebook(cluster_id)
        print(citation)

    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
