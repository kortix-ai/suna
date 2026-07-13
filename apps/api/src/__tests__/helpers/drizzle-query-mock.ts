export function collectConditionValues(condition: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const visit = (node: any) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node.queryChunks) visit(node.queryChunks);
    if (
      Object.prototype.hasOwnProperty.call(node, 'value') &&
      node.encoder?.name &&
      !Array.isArray(node.value)
    ) {
      values[node.encoder.name] = node.value;
    }
  };
  visit(condition);
  return values;
}

export function extractStringArray(condition: unknown): string[] | null {
  let result: string[] | null = null;
  const visit = (node: any) => {
    if (!node || result) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node.queryChunks) visit(node.queryChunks);
    if (
      Array.isArray(node.value) &&
      node.encoder?.name &&
      node.value.every((item: unknown) => typeof item === 'string')
    ) {
      result = node.value;
    }
  };
  visit(condition);
  return result;
}

export function queryResult<T = any>(rows: T[]) {
  return {
    then: (resolve: (value: T[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    limit: async (count: number) => rows.slice(0, count),
    orderBy: async () => rows,
  };
}
