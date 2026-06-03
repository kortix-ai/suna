declare module 'sql.js' {
  export class Database {
    constructor(data?: ArrayLike<number>);
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<{ Database: typeof Database }>;
}
