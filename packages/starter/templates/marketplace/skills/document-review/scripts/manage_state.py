#!/usr/bin/env python3
"""Document review state management via document_review_state.json."""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Callable, Iterable
from typing import NamedTuple, NoReturn

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


def fail(message: str) -> NoReturn:
    """Print an error to stderr and exit 1."""
    print(message, file=sys.stderr)
    sys.exit(1)


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
        fail("Error: document_review_state.json not found. Run 'init' first.")
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
        fail(f"Error: {label} missing required keys: {', '.join(missing)}")


def _validate_enum(value: str, allowed: set[str], field_name: str) -> None:
    """Exit with error if value is not in allowed set."""
    if value not in allowed:
        fail(f"Error: Invalid {field_name} '{value}'. Must be one of: {', '.join(sorted(allowed))}")


def _validate_positive_int(value: str | int, field_name: str) -> int:
    """Parse and validate a positive integer, exit on failure."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        fail(f"Error: {field_name} must be an integer, got '{value}'")
    if n < 1:
        fail(f"Error: {field_name} must be >= 1, got {n}")
    return n


def _validate_nonempty_str(value: object, field_name: str) -> str:
    """Validate that value is a non-empty string, exit on failure."""
    if not isinstance(value, (str, int)):
        fail(f"Error: {field_name} must be a string, got {type(value).__name__}")
    s = str(value)
    if not s.strip():
        fail(f"Error: {field_name} must not be empty")
    return s


def _validate_anchor(value: object, field_name: str) -> str | None:
    """Validate that value is a non-empty string or None, exit on failure."""
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        fail(f"Error: {field_name} must be a non-empty string or null")
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
        fail("Error: filename must not be empty")

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
        fail("Error: Must provide at least one section.")

    for section in sections:
        _validate_required_keys(
            section,
            ["name", "start_page", "end_page"],
            "Section",
        )
        name = section["name"]
        if not name.strip():
            fail("Error: Section name must not be empty.")
        start = _validate_positive_int(section["start_page"], "start_page")
        end = _validate_positive_int(section["end_page"], "end_page")
        if end < start:
            fail(f"Error: end_page ({end}) must be >= start_page ({start}) for section '{name}'.")

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


def _build_claim(data: dict, claim_id: str, section_name: str, loc: str, anc: str | None) -> dict:
    return {
        "claim_id": claim_id,
        "claim_type": data["claim_type"],
        "claim_status": "unverified",
        "description": data["description"],
        "original_text": data["original_text"],
        "section": section_name,
        "location": loc,
        "anchor": anc,
        "attempts": 0,
        "source_urls": [],
    }


def _build_issue(data: dict, issue_id: str, section_name: str, loc: str, anc: str | None) -> DocumentIssue:
    return {
        "issue_id": issue_id,
        "issue_type": data["issue_type"],
        "severity": data["severity"],
        "description": data["description"],
        "section": section_name,
        "location": loc,
        "anchor": anc,
        "original_text": data["original_text"],
        "text_context": data["text_context"],
        "new_text": data["new_text"],
        "root_issue_id": data.get("root_issue_id"),
    }


class RecordSpec(NamedTuple):
    """Everything that differs between the claims and issues collections."""

    noun: str  # "claim" / "issue": id prefix, counter and id-key stem
    collection: str  # "claims" / "issues": state key, command suffix, messages
    label: str  # error-message label
    phase: str  # phase the add command expects
    advance_from: str | None  # phase this command moves on to `phase` from
    required: list[str]
    enums: list[tuple[str, set[str]]]
    build: Callable[[dict, str, str, str, str | None], dict]
    emit_keys: list[str]
    header: str  # str.format template of the first printed line
    fields: list[tuple[str, str, bool]]  # (label, key, optional) printed after Section/Location


CLAIMS = RecordSpec(
    noun="claim",
    collection="claims",
    label="Claim",
    phase="find_claims",
    advance_from=None,
    required=["claim_type", "description", "original_text", "location"],
    enums=[("claim_type", CLAIM_TYPES)],
    build=_build_claim,
    emit_keys=["claim_id", "claim_type", "claim_status", "section", "location"],
    header="{claim_id} [{claim_status}] ({claim_type})",
    fields=[
        ("Anchor", "anchor", True),
        ("Text", "original_text", False),
        ("Description", "description", False),
        ("Sources", "source_urls", True),
    ],
)

ISSUES = RecordSpec(
    noun="issue",
    collection="issues",
    label="Issue",
    phase="find_issues",
    advance_from="fact_check",
    required=["issue_type", "severity", "description", "location", "original_text", "text_context", "new_text"],
    enums=[("issue_type", ISSUE_TYPES), ("severity", ISSUE_SEVERITIES)],
    build=_build_issue,
    emit_keys=["issue_id", "issue_type", "severity", "section", "location"],
    header="{issue_id} [{severity}] {issue_type}",
    fields=[
        ("Anchor", "anchor", True),
        ("Text", "original_text", False),
        ("Context", "text_context", False),
        ("Description", "description", False),
        ("Suggested", "new_text", True),
    ],
)


def _add_records(args: argparse.Namespace, spec: RecordSpec) -> None:
    """Add records for a section from JSON data."""
    state = load_state()
    phase_before = state["phase"]
    warn_phase(state, spec.phase)

    if state["phase"] == spec.advance_from:
        state["phase"] = spec.phase

    section_name = args.section_name
    if section_name not in state["sections"]:
        fail(f"Error: Section '{section_name}' not found.")

    items = json.loads(_resolve_data(args))
    if not isinstance(items, list):
        fail("Error: --data must be a JSON array.")

    created = []
    for item in items:
        _validate_required_keys(item, spec.required, spec.label)
        for key, allowed in spec.enums:
            _validate_enum(item[key], allowed, key)
        loc = _validate_nonempty_str(item["location"], "location")
        anc = _validate_anchor(item.get("anchor"), "anchor")

        state[f"{spec.noun}_counter"] += 1
        record_id = f"{spec.noun}:{state[f'{spec.noun}_counter']}"
        record = spec.build(item, record_id, section_name, loc, anc)
        state[spec.collection][record_id] = record
        created.append(record)

    save_state(state)
    log_action(
        f"add-{spec.collection}",
        phase_before,
        state["phase"],
        section=section_name,
        **{
            f"{spec.collection}_added": len(created),
            f"{spec.noun}_ids": [r[f"{spec.noun}_id"] for r in created],
        },
    )
    total = len(state[spec.collection])
    _emit_result(
        f'Added {len(created)} {spec.collection} for "{section_name}". Total {spec.collection}: {total}.',
        state["phase"],
        state["document_filename"],
        **{spec.collection: [{k: r[k] for k in spec.emit_keys} for r in created]},
    )


def cmd_add_claims(args: argparse.Namespace) -> None:
    """Add claims for a section from JSON data."""
    _add_records(args, CLAIMS)


def cmd_update_claims(args: argparse.Namespace) -> None:
    """Update claim statuses from JSON data."""
    state = load_state()
    phase_before = state["phase"]
    warn_phase(state, "fact_check")

    if state["phase"] == "find_claims":
        state["phase"] = "fact_check"

    updates = json.loads(_resolve_data(args))
    if not isinstance(updates, list):
        fail("Error: --data must be a JSON array.")

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
            fail(f"Error: Claim '{claim_id}' not found.")

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
            fail(f"Error: source_urls for '{claim_id}' must be a list of strings.")
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
    _add_records(args, ISSUES)


def cmd_submit(args: argparse.Namespace) -> None:
    """Mark review as complete with a summary."""
    state = load_state()
    phase_before = state["phase"]
    warn_phase(state, "find_issues")

    summary = args.summary
    if not summary.strip():
        fail("Error: Summary must not be empty.")

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


def _print_records(records: list[dict], spec: RecordSpec) -> None:
    for record in records:
        print(spec.header.format(**record))
        print(f"  Section: {record['section']} | Location: {record['location']}")
        for label, key, optional in spec.fields:
            value = record.get(key) if key in ("anchor", "source_urls") else record[key]
            if optional and not value:
                continue
            print(f"  {label}: {', '.join(value) if key == 'source_urls' else value}")
        print()


def _list_records(
    args: argparse.Namespace,
    collection: str,
    filter_name: str,
    filter_field: str,
    spec: RecordSpec,
) -> None:
    state = load_state()
    records = list(state[collection].values())

    filters = {}
    value = getattr(args, filter_name)
    if value:
        records = [record for record in records if record[filter_field] == value]
        filters[filter_name] = value
    if args.section:
        records = [record for record in records if record["section"] == args.section]
        filters["section"] = args.section

    log_action(
        f"get-{collection}",
        state["phase"],
        state["phase"],
        filters=filters,
        results=len(records),
    )

    if not records:
        print(f"No {collection} match the filter.")
        return

    _print_records(records, spec)
    print(f"Total: {len(records)} {collection}")


def cmd_get_claims(args: argparse.Namespace) -> None:
    """Print claims, optionally filtered by status/section."""
    _list_records(args, "claims", "status", "claim_status", CLAIMS)


def cmd_get_issues(args: argparse.Namespace) -> None:
    """Print issues, optionally filtered by severity/section."""
    _list_records(args, "issues", "severity", "severity", ISSUES)


def _count_by(records: Iterable[dict], key: str, order: Iterable[str] = ()) -> dict[str, int]:
    counts = dict.fromkeys(order, 0)
    for record in records:
        counts[record[key]] = counts.get(record[key], 0) + 1
    return counts


def _format_counts(counts: dict[str, int], sep: str) -> str:
    return sep.join(f"{key}: {val}" for key, val in counts.items() if val > 0)


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
        print(f"\nClaims ({len(claims)}):")
        status_order = ["unverified", "verified", "refuted", "inconclusive"]
        print(f"  {_format_counts(_count_by(claims.values(), 'claim_status', status_order), ' | ')}")

    issues = state["issues"]
    if issues:
        print(f"\nIssues ({len(issues)}):")
        print(f"  {_format_counts(_count_by(issues.values(), 'severity'), ' | ')}")
        print(f"  By type: {_format_counts(_count_by(issues.values(), 'issue_type'), ', ')}")

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
