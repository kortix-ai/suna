# Control-plane review conversation

## Goal

Show how agent work reaches `main` through a human decision. The panel must read as one conversation, not a dashboard.

## Layout

- Use the transcript structure from `StepComputer`: a user message above one agent sheet.
- The user message says `Open a change request`.
- The agent sheet returns one change-request card with the changed-file count and branch path.
- A full-height review gate covers the showcase and offers `Request changes` or `Approve & merge`.
- After approval, the branch path fills toward `main` and the request card changes to `Merged`.

## Interaction

- Reveal the user message, change request, and review gate once when the showcase enters view.
- Animate the existing `Cursor` icon from the review card onto `Approve & merge`.
- Simulate a short button press, then animate the merge path before revealing the merged card.
- Let either button work when a visitor acts before the automatic sequence finishes.
- A manual decision cancels the automatic sequence.
- Under reduced motion, show the pending review immediately and wait for a manual decision.

## Visual Rules

- Fill the complete showcase height with the transcript and review gate.
- Use semantic Kortix tokens, flat bordered surfaces, one state color, and Phosphor status icons.
- Keep the complete pending and resolved states legible in the 256 px mobile frame.
- Keep visible copy to the prompt, request title, decision, and status.
