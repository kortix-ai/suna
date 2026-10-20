import { beforeEach, expect, mock, test } from 'bun:test';
import { qk } from './query-keys';

// The gateway is the only model path: the `/model-picker` readers fetch for
// every project and never wait on a project-detail flag read.
let queried: { queryKey: unknown; enabled: unknown }[] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: { queryKey: unknown; enabled: unknown }) => {
    queried.push({ queryKey: config.queryKey, enabled: config.enabled });
    return { data: undefined };
  },
  useMutation: () => ({ mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({}),
}));
mock.module('react', () => ({
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
}));

const { useProjectModelPickerCatalog, useProjectModels } = await import('./use-project-models');
const { useModelEnablement } = await import('./use-model-enablement');

beforeEach(() => {
  queried = [];
});

test('every /model-picker reader fetches for a project with no detail read', () => {
  useProjectModels('P1');
  useProjectModelPickerCatalog('P1');
  useModelEnablement('P1');
  expect(queried).toEqual([
    { queryKey: qk.project.modelPicker('P1'), enabled: true },
    { queryKey: qk.project.modelPicker('P1'), enabled: true },
    { queryKey: qk.project.modelPicker('P1'), enabled: true },
  ]);
});

test('no project: nothing fetches', () => {
  useProjectModels(null);
  expect(queried).toEqual([{ queryKey: qk.project.modelPicker(''), enabled: false }]);
});
