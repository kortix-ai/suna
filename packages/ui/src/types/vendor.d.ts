// Ambient types for untyped vendor modules the package imports. apps/web keeps its own copy in src/types/vendor.d.ts.
declare module 'sql.js' {
  export class Database {
    constructor(data?: ArrayLike<number>);
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }
  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<{ Database: typeof Database }>;
}
