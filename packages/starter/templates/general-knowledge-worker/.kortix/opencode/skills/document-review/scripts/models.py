from typing import TypedDict


class DocumentIssue(TypedDict):
    """A single review issue from document_review_state.json."""

    issue_id: str
    issue_type: str
    severity: str
    description: str
    section: str
    location: str
    anchor: str | None
    original_text: str
    text_context: str
    new_text: str
    root_issue_id: str | None


ISSUE_TYPE_LABELS = {
    "spelling_grammar": "Spelling/Grammar",
    "narrative_logic": "Narrative/Logic",
    "non_public_info": "Non-Public Info",
    "verify_public_data": "Public Data",
    "numerical_consistency": "Numerical Consistency",
}


def format_comment(issue: DocumentIssue, include_suggestion: bool = True) -> str:
    label = ISSUE_TYPE_LABELS.get(issue["issue_type"], issue["issue_type"])
    sev = issue["severity"]
    parts = [f"[{label} | {sev}]", "", issue["description"]]
    if include_suggestion and issue.get("new_text"):
        parts.extend(["", f"Suggested: {issue['new_text']}"])
    return "\n".join(parts)
