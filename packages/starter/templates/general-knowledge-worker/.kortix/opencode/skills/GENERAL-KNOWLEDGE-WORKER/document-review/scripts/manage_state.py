#!/usr/bin/env python3
"""Document review state management via document_review_state.json."""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from constants import LOG_FILENAME, STATE_FILENAME
from models import DocumentIssue

PHASES = [
    "outline",
    "find_claims",
    "fact_check",
    "find_issues",
    "complete",
]

CLAIM_TYPES = {"verify_public_data", "numerical_consistency"}
CLAIM_STATUSES = {
    "unverified",
    "verified",
    "refuted",
    "inconclusive",
}
ISSUE_TYPES = {
    "verify_public_data",
    "numerical_consistency",
    "spelling_grammar",
    "non_public_info",
    "narrative_logic",
}
ISSUE_SEVERITIES = {"high", "medium", "low"}


def _emit_result(message: str, phase: str, document_name: str, **kwargs: list[dict]) -> None:
    """Print a single JSON object as the command's stdout result.

    Combines the human-readable message with structured progress data
    so the entire output is valid JSON.
    """
    payload: dict = {
        "message": message,
        "document_review_progress": {
            "phase": phase,
            "document_name": document_name,
            **kwargs,
        },
    }
    print(json.dumps(payload))


def log_action(
    command: str,
    phase_before: str | None,
    phase_after: str | None,
    **kwargs: object,
) -> None:
    """Append a structured log entry to the JSONL log."""
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "command": command,
        "phase_before": phase_before,
        "phase_after": phase_after,
        **kwargs,
    }
    with Path(LOG_FILENAME).open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def load_state() -> dict:
    """Load review state from disk, exit if missing."""
    path = Path(STATE_FILENAME)
    if not path.exists():
        print(
            "Error: document_review_state.json not found. Run 'init' first.",
            file=sys.stderr,
        )
        sys.exit(1)
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(state: dict) -> None:
    """Write review state to disk as formatted JSON."""
    Path(STATE_FILENAME).write_text(json.dumps(state, indent=2), encoding="utf-8")


def warn_phase(state: dict, expected: str) -> None:
    """Warn on stderr if the current phase is unexpected."""
    if state["phase"] != expected:
        print(
            f"WARNING: Expected phase '{expected}' but currently in '{state['phase']}'. Proceeding anyway.",
            file=sys.stderr,
        )


def _validate_required_keys(item: dict, required: list[str], label: str) -> None:
    """Exit with error if any required keys are missing."""
    missing = [k for k in required if k not in item]
    if missing:
        print(
            f"Error: {label} missing required keys: {', '.join(missing)}",
            file=sys.stderr,
        )
        sys.exit(1)


def _validate_enum(value: str, allowed: set[str], field_name: str) -> None:
    """Exit with error if value is not in allowed set."""
    if value not in allowed:
        print(
            f"Error: Invalid {field_name} '{value}'. Must be one of: {', '.join(sorted(allowed))}",
            file=sys.stderr,
        )
        sys.exit(1)


def _validate_positive_int(value: str | int, field_name: str) -> int:
    """Parse and validate a positive integer, exit on failure."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        print(
            f"Error: {field_name} must be an integer, got '{value}'",
            file=sys.stderr,
        )
        sys.exit(1)
    if n < 1:
        print(
            f"Error: {field_name} must be >= 1, got {n}",
            file=sys.stderr,
        )
        sys.exit(1)
    return n


def _validate_nonempty_str(value: object, field_name: str) -> str:
    """Validate that value is a non-empty string, exit on failure."""
    if not isinstance(value, (str, int)):
        print(
            f"Error: {field_name} must be a string, got {type(value).__name__}",
            file=sys.stderr,
        )
        sys.exit(1)
    s = str(value)
    if not s.strip():
        print(
            f"Error: {field_name} must not be empty",
            file=sys.stderr,
        )
        sys.exit(1)
    return s


def _validate_anchor(value: object, field_name: str) -> str | None:
    """Validate that value is a non-empty string or None, exit on failure."""
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        print(
            f"Error: {field_name} must be a non-empty string or null",
            file=sys.stderr,
        )
        sys.exit(1)
    return value


def _resolve_data(args: argparse.Namespace) -> str:
    """Return JSON string from --data or --file."""
    if args.file:
        return Path(args.file).read_text(encoding="utf-8")
    return args.data


def cmd_init(args: argparse.Namespace) -> None:
    """Initialize a new review for the given document."""
    filename = args.filename
    if not filename.strip():
        print(
            "Error: filename must not be empty",
            file=sys.stderr,
        )
        sys.exit(1)

    state = {
        "phase": "outline",
        "document_filename": filename,
        "sections": {},
        "claims": {},
        "issues": {},
        "summary": "",
        "claim_counter": 0,
        "issue_counter": 0,
    }
    save_state(state)
    log_action("init", None, "outline", document_filename=filename)
    _emit_result(
        f'Initialized review for "{filename}".',
        state["phase"],
        filename,
    )


def cmd_add_sections(args: argparse.Namespace) -> None:
    """Add document sections from JSON data."""
    state = load_state()
    warn_phase(state, "outline")

    sections = json.loads(_resolve_data(args))
    if not isinstance(sections, list) or len(sections) == 0:
        print(
            "Error: Must provide at least one section.",
            file=sys.stderr,
        )
        sys.exit(1)

    for section in sections:
        _validate_required_keys(
            section,
            ["name", "start_page", "end_page"],
            "Section",
        )
        name = section["name"]
        if not name.strip():
            print(
                "Error: Section name must not be empty.",
                file=sys.stderr,
            )
            sys.exit(1)
        start = _validate_positive_int(section["start_page"], "start_page")
        end = _validate_positive_int(section["end_page"], "end_page")
        if end < start:
            print(
                f"Error: end_page ({end}) must be >= start_page ({start}) for section '{name}'.",
                file=sys.stderr,
            )
            sys.exit(1)

        state["sections"][name] = {
            "name": name,
            "start_page": start,
            "end_page": end,
            "description": section.get("description"),
        }

    phase_before = state["phase"]
    state["phase"] = "find_claims"
    save_state(state)
    log_action(
        "add-sections",
        phase_before,
        "find_claims",
        section_count=len(sections),
        section_names=list(state["sections"]),
    )
    _emit_result(
        f"Added {len(sections)} sections. Phase: find_claims.",
        state["phase"],
        state["document_filename"],
        sections=[{"name": s["name"], "start_page": s["start_page"], "end_page": s["end_page"]} for s in sections],
    )


def cmd_add_claims(args: argparse.Namespace) -> None:
    """Add claims for a section from JSON data."""
    state = load_state()
    warn_phase(state, "find_claims")

    section_name = args.section_name
    if section_name not in state["sections"]:
        print(
            f"Error: Section '{section_name}' not found.",
            file=sys.stderr,
        )
        sys.exit(1)

    claims = json.loads(_resolve_data(args))
    if not isinstance(claims, list):
        print(
            "Error: --data must be a JSON array.",
            file=sys.stderr,
        )
        sys.exit(1)

    created = []
    for claim_data in claims:
        _validate_required_keys(
            claim_data,
            [
                "claim_type",
                "description",
                "original_text",
                "location",
            ],
            "Claim",
        )
        _validate_enum(
            claim_data["claim_type"],
            CLAIM_TYPES,
            "claim_type",
        )
        loc = _validate_nonempty_str(claim_data["location"], "location")
        anc = _validate_anchor(claim_data.get("anchor"), "anchor")

        state["claim_counter"] += 1
        claim_id = f"claim:{state['claim_counter']}"
        claim = {
            "claim_id": claim_id,
            "claim_type": claim_data["claim_type"],
            "claim_status": "unverified",
            "description": claim_data["description"],
            "original_text": claim_data["original_text"],
            "section": section_name,
            "location": loc,
            "anchor": anc,
            "attempts": 0,
            "source_urls": [],
        }
        state["claims"][claim_id] = claim
        created.append(claim)

    save_state(state)
    log_action(
        "add-claims",
        state["phase"],
        state["phase"],
        section=section_name,
        claims_added=len(created),
        claim_ids=[c["claim_id"] for c in created],
    )
    total = len(state["claims"])
    _emit_result(
        f'Added {len(created)} claims for "{section_name}". Total claims: {total}.',
        state["phase"],
        state["document_filename"],
        claims=[
            {
                "claim_id": c["claim_id"],
                "claim_type": c["claim_type"],
                "claim_status": c["claim_status"],
                "section": c["section"],
                "location": c["location"],
            }
            for c in created
        ],
    )


def cmd_update_claims(args: argparse.Namespace) -> None:
    """Update claim statuses from JSON data."""
    state = load_state()
    phase_before = state["phase"]
    warn_phase(state, "fact_check")

    if state["phase"] == "find_claims":
        state["phase"] = "fact_check"

    updates = json.loads(_resolve_data(args))
    if not isinstance(updates, list):
        print(
            "Error: --data must be a JSON array.",
            file=sys.stderr,
        )
        sys.exit(1)

    counts = {
        "verified": 0,
        "refuted": 0,
        "inconclusive": 0,
    }
    for update in updates:
        _validate_required_keys(
            update,
            ["claim_id", "claim_status"],
            "Claim update",
        )
        claim_id = update["claim_id"]
        status = update["claim_status"]

        if claim_id not in state["claims"]:
            print(
                f"Error: Claim '{claim_id}' not found.",
                file=sys.stderr,
            )
            sys.exit(1)

        _validate_enum(
            status,
            CLAIM_STATUSES - {"unverified"},
            "claim_status",
        )

        claim = state["claims"][claim_id]
        claim["claim_status"] = status
        claim["attempts"] += 1

        source_urls = update.get("source_urls", [])
        if not isinstance(source_urls, list) or not all(isinstance(u, str) for u in source_urls):
            print(
                f"Error: source_urls for '{claim_id}' must be a list of strings.",
                file=sys.stderr,
            )
            sys.exit(1)
        claim.setdefault("source_urls", [])
        claim["source_urls"].extend(source_urls)

        counts[status] += 1

    save_state(state)
    log_action(
        "update-claims",
        phase_before,
        state["phase"],
        claims_updated=len(updates),
        status_counts=counts,
    )
    _emit_result(
        f"Updated {len(updates)} claims."
        f" Verified: {counts['verified']},"
        f" Refuted: {counts['refuted']},"
        f" Inconclusive: {counts['inconclusive']}.",
        state["phase"],
        state["document_filename"],
        claims=[
            {
                "claim_id": u["claim_id"],
                "claim_status": u["claim_status"],
                "source_urls": state["claims"][u["claim_id"]].get("source_urls", []),
            }
            for u in updates
        ],
    )


def cmd_add_issues(args: argparse.Namespace) -> None:
    """Add issues for a section from JSON data."""
    state = load_state()
    phase_before = state["phase"]
    warn_phase(state, "find_issues")

    if state["phase"] == "fact_check":
        state["phase"] = "find_issues"

    section_name = args.section_name
    if section_name not in state["sections"]:
        print(
            f"Error: Section '{section_name}' not found.",
            file=sys.stderr,
        )
        sys.exit(1)

    issues = json.loads(_resolve_data(args))
    if not isinstance(issues, list):
        print(
            "Error: --data must be a JSON array.",
            file=sys.stderr,
        )
        sys.exit(1)

    created = []
    for issue_data in issues:
        _validate_required_keys(
            issue_data,
            [
                "issue_type",
                "severity",
                "description",
                "location",
                "original_text",
                "text_context",
                "new_text",
            ],
            "Issue",
        )
        _validate_enum(
            issue_data["issue_type"],
            ISSUE_TYPES,
            "issue_type",
        )
        _validate_enum(
            issue_data["severity"],
            ISSUE_SEVERITIES,
            "severity",
        )
        loc = _validate_nonempty_str(issue_data["location"], "location")
        anc = _validate_anchor(issue_data.get("anchor"), "anchor")

        state["issue_counter"] += 1
        issue_id = f"issue:{state['issue_counter']}"
        issue: DocumentIssue = {
            "issue_id": issue_id,
            "issue_type": issue_data["issue_type"],
            "severity": issue_data["severity"],
            "description": issue_data["description"],
            "section": section_name,
            "location": loc,
            "anchor": anc,
            "original_text": issue_data["original_text"],
            "text_context": issue_data["text_context"],
            "new_text": issue_data["new_text"],
            "root_issue_id": issue_data.get("root_issue_id"),
        }
        state["issues"][issue_id] = issue
        created.append(issue)

    save_state(state)
    log_action(
        "add-issues",
        phase_before,
        state["phase"],
        section=section_name,
        issues_added=len(created),
        issue_ids=[iss["issue_id"] for iss in created],
    )
    total = len(state["issues"])
    _emit_result(
        f'Added {len(created)} issues for "{section_name}". Total issues: {total}.',
        state["phase"],
        state["document_filename"],
        issues=[
            {
                "issue_id": i["issue_id"],
                "issue_type": i["issue_type"],
                "severity": i["severity"],
                "section": i["section"],
                "location": i["location"],
            }
            for i in created
        ],
    )


def cmd_submit(args: argparse.Namespace) -> None:
    """Mark review as complete with a summary."""
    state = load_state()
    phase_before = state["phase"]
    warn_phase(state, "find_issues")

    summary = args.summary
    if not summary.strip():
        print(
            "Error: Summary must not be empty.",
            file=sys.stderr,
        )
        sys.exit(1)

    state["phase"] = "complete"
    state["summary"] = summary
    save_state(state)

    n_sections = len(state["sections"])
    n_claims = len(state["claims"])
    n_issues = len(state["issues"])
    log_action(
        "submit",
        phase_before,
        "complete",
        sections=n_sections,
        claims=n_claims,
        issues=n_issues,
    )
    _emit_result(
        f"Review complete. Sections: {n_sections}, Claims: {n_claims}, Issues: {n_issues}.",
        state["phase"],
        state["document_filename"],
    )


def cmd_get_claims(args: argparse.Namespace) -> None:
    """Print claims, optionally filtered by status/section."""
    state = load_state()
    claims = list(state["claims"].values())

    filters = {}
    if args.status:
        claims = [claim for claim in claims if claim["claim_status"] == args.status]
        filters["status"] = args.status
    if args.section:
        claims = [claim for claim in claims if claim["section"] == args.section]
        filters["section"] = args.section

    log_action(
        "get-claims",
        state["phase"],
        state["phase"],
        filters=filters,
        results=len(claims),
    )

    if not claims:
        print("No claims match the filter.")
        return

    for claim in claims:
        cid = claim["claim_id"]
        cstatus = claim["claim_status"]
        ctype = claim["claim_type"]
        print(f"{cid} [{cstatus}] ({ctype})")
        print(f"  Section: {claim['section']} | Location: {claim['location']}")
        if claim.get("anchor"):
            print(f"  Anchor: {claim['anchor']}")
        print(f"  Text: {claim['original_text']}")
        print(f"  Description: {claim['description']}")
        urls = claim.get("source_urls", [])
        if urls:
            print(f"  Sources: {', '.join(urls)}")
        print()

    print(f"Total: {len(claims)} claims")


def cmd_get_issues(args: argparse.Namespace) -> None:
    """Print issues, optionally filtered by severity/section."""
    state = load_state()
    issues = list(state["issues"].values())

    filters = {}
    if args.severity:
        issues = [issue for issue in issues if issue["severity"] == args.severity]
        filters["severity"] = args.severity
    if args.section:
        issues = [issue for issue in issues if issue["section"] == args.section]
        filters["section"] = args.section

    log_action(
        "get-issues",
        state["phase"],
        state["phase"],
        filters=filters,
        results=len(issues),
    )

    if not issues:
        print("No issues match the filter.")
        return

    for issue in issues:
        iid = issue["issue_id"]
        sev = issue["severity"]
        itype = issue["issue_type"]
        print(f"{iid} [{sev}] {itype}")
        print(f"  Section: {issue['section']} | Location: {issue['location']}")
        if issue.get("anchor"):
            print(f"  Anchor: {issue['anchor']}")
        print(f"  Text: {issue['original_text']}")
        print(f"  Context: {issue['text_context']}")
        print(f"  Description: {issue['description']}")
        if issue["new_text"]:
            print(f"  Suggested: {issue['new_text']}")
        print()

    print(f"Total: {len(issues)} issues")


def cmd_status(_args: argparse.Namespace) -> None:
    """Print a dashboard of current review progress."""
    state = load_state()

    doc = state["document_filename"]
    print(f"Document Review: {doc}")
    print(f"Phase: {state['phase']}")

    sections = state["sections"]
    if sections:
        print(f"\nSections ({len(sections)}):")
        for section in sections.values():
            name = section["name"]
            start = section["start_page"]
            end = section["end_page"]
            print(f"  {name} [pp. {start}-{end}]")

    claims = state["claims"]
    if claims:
        status_counts: dict[str, int] = {
            "unverified": 0,
            "verified": 0,
            "refuted": 0,
            "inconclusive": 0,
        }
        for claim in claims.values():
            cs = claim["claim_status"]
            status_counts[cs] = status_counts.get(cs, 0) + 1
        parts = [f"{key}: {val}" for key, val in status_counts.items() if val > 0]
        print(f"\nClaims ({len(claims)}):")
        print(f"  {' | '.join(parts)}")

    issues = state["issues"]
    if issues:
        sev_counts: dict[str, int] = {}
        type_counts: dict[str, int] = {}
        for issue in issues.values():
            sev = issue["severity"]
            itype = issue["issue_type"]
            sev_counts[sev] = sev_counts.get(sev, 0) + 1
            type_counts[itype] = type_counts.get(itype, 0) + 1
        sev_parts = [f"{key}: {val}" for key, val in sev_counts.items()]
        type_parts = [f"{key}: {val}" for key, val in type_counts.items()]
        print(f"\nIssues ({len(issues)}):")
        print(f"  {' | '.join(sev_parts)}")
        print(f"  By type: {', '.join(type_parts)}")

    if state["summary"]:
        print(f"\nSummary: {state['summary']}")


def main() -> None:
    """Parse arguments and dispatch to subcommand."""
    parser = argparse.ArgumentParser(description="Document review state management")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init")
    p_init.add_argument("filename")

    p_sections = sub.add_parser("add-sections")
    g_sections = p_sections.add_mutually_exclusive_group(required=True)
    g_sections.add_argument("--data")
    g_sections.add_argument("--file")

    p_claims = sub.add_parser("add-claims")
    p_claims.add_argument("section_name")
    g_claims = p_claims.add_mutually_exclusive_group(required=True)
    g_claims.add_argument("--data")
    g_claims.add_argument("--file")

    p_update = sub.add_parser("update-claims")
    g_update = p_update.add_mutually_exclusive_group(required=True)
    g_update.add_argument("--data")
    g_update.add_argument("--file")

    p_issues = sub.add_parser("add-issues")
    p_issues.add_argument("section_name")
    g_issues = p_issues.add_mutually_exclusive_group(required=True)
    g_issues.add_argument("--data")
    g_issues.add_argument("--file")

    p_submit = sub.add_parser("submit")
    p_submit.add_argument("summary")

    p_get_claims = sub.add_parser("get-claims")
    p_get_claims.add_argument("--status", default=None)
    p_get_claims.add_argument("--section", default=None)

    p_get_issues = sub.add_parser("get-issues")
    p_get_issues.add_argument("--severity", default=None)
    p_get_issues.add_argument("--section", default=None)

    sub.add_parser("status")

    args = parser.parse_args()

    commands = {
        "init": cmd_init,
        "add-sections": cmd_add_sections,
        "add-claims": cmd_add_claims,
        "update-claims": cmd_update_claims,
        "add-issues": cmd_add_issues,
        "submit": cmd_submit,
        "get-claims": cmd_get_claims,
        "get-issues": cmd_get_issues,
        "status": cmd_status,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
