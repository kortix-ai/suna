export interface StatusElapsedState {
  status: string;
  working: boolean;
  startedAtMs: number;
  elapsedMs: number;
}

export interface StatusElapsedInput {
  status: string;
  working: boolean;
  nowMs: number;
}

export function statusElapsedFrame(
  previous: StatusElapsedState | undefined,
  input: StatusElapsedInput,
): StatusElapsedState {
  if (!previous || previous.status !== input.status || previous.working !== input.working) {
    return {
      status: input.status,
      working: input.working,
      startedAtMs: input.nowMs,
      elapsedMs: 0,
    };
  }

  return {
    ...previous,
    elapsedMs: input.working ? Math.max(0, input.nowMs - previous.startedAtMs) : 0,
  };
}
