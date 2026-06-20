declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown';
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}

declare module 'file-saver' {
  export function saveAs(data: Blob | string, filename?: string, options?: any): void;
}

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
