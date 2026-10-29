/**
 * The model and agent a chat conversation runs on, for every platform.
 */
import { labelForModelRef } from '../../llm-gateway/models/picker';

/**
 * The model the next message runs on: the conversation's `/model` choice —
 * it reaches the live session too — else the model the live session started
 * with (`pin`), else the project default. "project default" beside a session
 * pinned to another model was how a chat stuck on a model it could not run
 * looked fine.
 */
export function statusModel(choice: string | null, pin: string | null): string {
  if (choice) return labelForModelRef(choice);
  if (pin) return `${labelForModelRef(pin)} (this session)`;
  return 'project default';
}
