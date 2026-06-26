#!/usr/bin/env python3
"""Convert OpenAlex API JSON response to BibTeX entries.

Usage:
    # Pipe from curl
    curl -s "https://api.openalex.org/works?search=topic&per_page=10&mailto=agent@kortix.ai" | python3 openalex_to_bibtex.py

    # From file
    python3 openalex_to_bibtex.py < results.json

    # Single work object (not a search response)
    python3 openalex_to_bibtex.py --single < work.json

    # Append to existing .bib file
    curl -s "..." | python3 openalex_to_bibtex.py >> references.bib

Output: BibTeX entries to stdout, one per work. Diagnostics to stderr.
"""

import json
import sys
import re
import unicodedata

def normalize_ascii(text):
    """Normalize unicode to ASCII-safe LaTeX-compatible text."""
    if not text:
        return ""
    # NFKD decomposition, strip combining marks
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    # Replace common special chars
    replacements = {
        "\u2013": "--", "\u2014": "---", "\u2018": "`", "\u2019": "'",
        "\u201c": "``", "\u201d": "''", "\u00e9": "\\'e", "\u00e8": "\\`e",
        "\u00f6": '\\"o', "\u00fc": '\\"u', "\u00e4": '\\"a', "\u00f1": "\\~n",
        "\u00e7": "\\c{c}", "&": "\\&", "%": "\\%", "#": "\\#", "_": "\\_",
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    return text

def make_cite_key(work):
    """Generate a citation key: firstauthorlastname + year + first_content_word."""
    year = work.get("publication_year", "XXXX") or "XXXX"
    # Get first author's last name
    authorships = work.get("authorships", [])
    if authorships:
        name = authorships[0].get("author", {}).get("display_name", "unknown")
        # Take last word as surname (handles "First Last" and "First M. Last")
        lastname = name.strip().split()[-1].lower() if name else "unknown"
    else:
        lastname = "unknown"
    # Clean surname to alphanumeric
    lastname = re.sub(r"[^a-z]", "", lastname)
    # Get first meaningful word from title
    title = work.get("display_name", "") or ""
    stop_words = {"a", "an", "the", "on", "in", "of", "for", "and", "to", "with", "from", "by"}
    words = re.findall(r"[a-z]+", title.lower())
    content_word = ""
    for w in words:
        if w not in stop_words and len(w) > 2:
            content_word = w
            break
    if not content_word and words:
        content_word = words[0]
    return f"{lastname}{year}{content_word}"

def format_authors(authorships):
    """Format OpenAlex authorships to BibTeX author string."""
    if not authorships:
        return "Unknown"
    names = []
    for a in authorships:
        name = a.get("author", {}).get("display_name", "")
        if name:
            names.append(name)
    if not names:
        return "Unknown"
    return " and ".join(names)

def get_journal_or_venue(work):
    """Extract journal name or conference venue."""
    loc = work.get("primary_location", {}) or {}
    source = loc.get("source", {}) or {}
    return source.get("display_name", "")

def get_pages(work):
    """Extract page numbers from biblio field."""
    biblio = work.get("biblio", {}) or {}
    first = biblio.get("first_page", "")
    last = biblio.get("last_page", "")
    if first and last:
        return f"{first}--{last}"
    elif first:
        return first
    return ""

def get_volume_issue(work):
    """Extract volume and number from biblio."""
    biblio = work.get("biblio", {}) or {}
    return biblio.get("volume", ""), biblio.get("issue", "")

def work_to_bibtex(work):
    """Convert a single OpenAlex work object to a BibTeX entry string."""
    cite_key = make_cite_key(work)
    title = normalize_ascii(work.get("display_name", "Untitled"))
    authors = format_authors(work.get("authorships", []))
    year = work.get("publication_year", "")
    doi = work.get("doi", "") or ""
    if doi.startswith("https://doi.org/"):
        doi = doi[len("https://doi.org/"):]
    work_type = work.get("type", "article") or "article"
    journal = normalize_ascii(get_journal_or_venue(work))
    pages = get_pages(work)
    volume, number = get_volume_issue(work)
    oa_url = (work.get("open_access", {}) or {}).get("oa_url", "")

    # Determine BibTeX entry type
    type_map = {
        "article": "article",
        "review": "article",
        "preprint": "article",
        "book": "book",
        "book-chapter": "incollection",
        "proceedings-article": "inproceedings",
        "dissertation": "phdthesis",
        "dataset": "misc",
    }
    bib_type = type_map.get(work_type, "article")

    # Build fields
    fields = []
    fields.append(f"  title = {{{title}}}")
    fields.append(f"  author = {{{authors}}}")
    if year:
        fields.append(f"  year = {{{year}}}")
    if journal:
        if bib_type == "inproceedings":
            fields.append(f"  booktitle = {{{journal}}}")
        elif bib_type in ("article",):
            fields.append(f"  journal = {{{journal}}}")
        else:
            fields.append(f"  publisher = {{{journal}}}")
    if volume:
        fields.append(f"  volume = {{{volume}}}")
    if number:
        fields.append(f"  number = {{{number}}}")
    if pages:
        fields.append(f"  pages = {{{pages}}}")
    if doi:
        fields.append(f"  doi = {{{doi}}}")
    if oa_url:
        fields.append(f"  url = {{{oa_url}}}")
    if work_type == "preprint":
        fields.append(f"  note = {{Preprint}}")

    entry = f"@{bib_type}{{{cite_key},\n"
    entry += ",\n".join(fields)
    entry += "\n}\n"
    return cite_key, entry

def reconstruct_abstract(inverted_index):
    """Reconstruct plaintext abstract from OpenAlex inverted index."""
    if not inverted_index:
        return ""
    max_pos = max(max(positions) for positions in inverted_index.values())
    words = [""] * (max_pos + 1)
    for word, positions in inverted_index.items():
        for pos in positions:
            words[pos] = word
    return " ".join(w for w in words if w)

def main():
    single_mode = "--single" in sys.argv

    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(1)

    # Handle both search responses (with "results" array) and single work objects
    if single_mode or "results" not in data:
        works = [data]
    else:
        works = data.get("results", [])

    if not works:
        print("Warning: No works found in input.", file=sys.stderr)
        sys.exit(0)

    seen_keys = set()
    count = 0
    for work in works:
        cite_key, entry = work_to_bibtex(work)
        # Deduplicate keys
        original_key = cite_key
        suffix = 1
        while cite_key in seen_keys:
            suffix += 1
            cite_key = f"{original_key}{chr(96 + suffix)}"  # a, b, c...
            entry = entry.replace(f"{{{original_key},", f"{{{cite_key},", 1)
        seen_keys.add(cite_key)
        print(entry)
        count += 1

        # Print abstract as comment if available
        abstract_idx = work.get("abstract_inverted_index")
        if abstract_idx:
            abstract = reconstruct_abstract(abstract_idx)
            if abstract:
                # Print as BibTeX comment for reference
                print(f"% Abstract [{cite_key}]: {abstract[:300]}{'...' if len(abstract) > 300 else ''}")
                print()

    print(f"% Generated {count} BibTeX entries from OpenAlex", file=sys.stderr)

if __name__ == "__main__":
    main()
