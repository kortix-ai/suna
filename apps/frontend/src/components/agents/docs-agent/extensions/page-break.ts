import { Node, mergeAttributes } from '@tiptap/core';

export interface PageBreakOptions {
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
  }
}

export const PageBreak = Node.create<PageBreakOptions>({
  name: 'pageBreak',

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  group: 'block',

  parseHTML() {
    return [
      {
        tag: 'div[style*="page-break-after"]',
      },
      {
        tag: 'div.page-break',
      },
      {
        tag: 'hr.page-break',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'page-break',
        style: 'page-break-after: always; height: 0; margin: 48px 0; border-top: 2px dashed #d1d5db; position: relative;',
        'data-page-break': 'true',
      }),
      [
        'div',
        {
          style: 'position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: white; padding: 0 12px; color: #9ca3af; font-size: 12px; font-weight: 500;',
        },
        'Page Break',
      ],
    ];
  },

  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain, state }) => {
          const { $to } = state.selection;

          const isAtEnd = $to.pos === $to.end();

          if (!isAtEnd) {
            return false;
          }

          return chain()
            .insertContent({
              type: this.name,
            })
            .run();
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => this.editor.commands.setPageBreak(),
    };
  },
}); 