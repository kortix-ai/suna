# Session capacity and prompt recovery

## Purpose

This contract prevents prompt loss when a sandbox provider has no capacity.
It also stops automatic retries that cannot make progress.

## Capacity authority

The provider create operation is the capacity authority.
A separate capacity check cannot replace the provider create operation.
Concurrent requests can pass a separate check at the same time.

The API classifies the provider error after the provider rejects the create operation.
The API does not expose the raw provider error as user text.

## Retry policy

| Failure class | Provider create attempts | Client action |
| --- | ---: | --- |
| Provider capacity | 1 | Stop automatic polling. Show Retry. |
| Snapshot build in progress | 30 | Continue automatic retries. |
| Transient provider or network error | 3 | Continue bounded automatic retries. |
| Missing template | 1 | Return the template error. |

Capacity is deterministic for the current request.
Thirty capacity attempts add five minutes of delay without a new admission signal.

## `/start` terminal response

The API returns HTTP `200` with a terminal result.
The root `retriable` field controls automatic `/start` polling.
The nested `failure.retryable` field controls the visible Retry action.

```json
{
  "stage": "failed",
  "retriable": false,
  "sandbox": {
    "status": "error",
    "metadata": {
      "initAttempts": 1,
      "initMaxAttempts": 1,
      "failureCategory": "provider-capacity"
    }
  },
  "failure": {
    "category": "provider-capacity",
    "message": "The sandbox provider is at capacity right now. Try again in a minute.",
    "retryable": true
  }
}
```

The SDK stops polling when root `retriable` is `false`.
The UI does not show a startup spinner for this state.

## Prompt lifecycle

1. The project composer stores the normal browser start stash.
2. The create request also stores `pending_prompt` in session metadata.
3. The API does not add `pending_prompt` to `KORTIX_INITIAL_PROMPT`.
4. The API does not send `pending_prompt` to the runtime.
5. A capacity failure keeps `pending_prompt` unchanged.
6. The Retry action copies `pending_prompt` into the browser start stash.
7. The Retry action starts one explicit restart operation.
8. The runtime sends the prompt through the normal message path.
9. The web clears `pending_prompt` only after the runtime ACK.

This sequence prevents an unexpected delayed send.
A user action is necessary after every terminal capacity rejection.

## Attachment rule

Session metadata stores attachment names only.
The contract accepts a file-only request with an empty text field.
The current browser tab keeps the local `File` objects in the pending-files store.
A page reload can remove the local file bytes.
The capacity card tells the user to reattach files after a reload.

Cross-device attachment-byte recovery is not part of this contract.
That feature needs durable file upload before sandbox admission.

## Capacity card

The terminal capacity card shows these controls:

- `Retry` starts one explicit recovery attempt.
- `Copy prompt` copies the durable prompt text.
- `Delete` uses the standard session deletion path.

The card states that the prompt is saved.
The card shows the attachment count when attachment names exist.

## Deletion rule

Delete removes the session from project inventory.
Delete archives the sandbox row before the provider cleanup completes.
The existing deletion path owns provider cleanup and database cleanup.

## Required verification

The release test must fill all eight E2B slots.
The ninth create must fail after one provider call.
The ninth session must show the capacity card without a spinner.
The prompt must remain available through Copy prompt.
Retry must start only after the user selects Retry.
Retry must succeed after one running sandbox stops.
Delete must remove every disposable session and sandbox.
