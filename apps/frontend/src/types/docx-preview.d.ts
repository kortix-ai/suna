declare module 'docx-preview' {
  export interface RenderOptions {
    className?: string;
    inWrapper?: boolean;
    ignoreWidth?: boolean;
    ignoreHeight?: boolean;
    ignoreFonts?: boolean;
    breakPages?: boolean;
    ignoreLastRenderedPageBreak?: boolean;
    experimental?: boolean;
    trimXmlDeclaration?: boolean;
    useBase64URL?: boolean;
    renderHeaders?: boolean;
    renderFooters?: boolean;
    renderFootnotes?: boolean;
    renderEndnotes?: boolean;
    debug?: boolean;
  }

  export function renderAsync(
    data: ArrayBuffer | Blob,
    container: HTMLElement,
    styleContainer?: HTMLElement | null,
    options?: RenderOptions
  ): Promise<void>;
}
