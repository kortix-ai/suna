import type { RegisteredFlow } from './flow';

export function partitionParallelFlows(flows: RegisteredFlow[]): {
  apiLane: RegisteredFlow[];
  sandboxLane: RegisteredFlow[];
} {
  const apiLane: RegisteredFlow[] = [];
  const sandboxLane: RegisteredFlow[] = [];
  for (const flow of flows) {
    if (flow.meta.requires?.includes('daytona')) sandboxLane.push(flow);
    else apiLane.push(flow);
  }
  return { apiLane, sandboxLane };
}
