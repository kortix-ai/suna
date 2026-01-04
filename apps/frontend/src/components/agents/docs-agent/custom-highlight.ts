import { Mark, mergeAttributes } from '@tiptap/core';

export interface HighlightOptions {
  multicolor: boolean;
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    highlight: {
      setHighlight: (attributes?: { color: string }) => ReturnType;
      toggleHighlight: (attributes?: { color: string }) => ReturnType;
      unsetHighlight: () => ReturnType;
    };
  }
}

export const CustomHighlight = Mark.create<HighlightOptions>({
  name: 'highlight',

  addOptions() {
    return {
      multicolor: true,
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    if (!this.options.multicolor) {
      return {};
    }

    return {
      color: {
        default: null,
        parseHTML: element => {
          // Try to get color from style attribute first
          const style = element.getAttribute('style');
          if (style) {
            const match = style.match(/background-color:\s*([^;]+)/);
            if (match) {
              return match[1].trim();
            }
          }
          // Fallback to data-color attribute
          return element.getAttribute('data-color') || element.style.backgroundColor;
        },
        renderHTML: attributes => {
          if (!attributes.color) {
            return {};
          }

          return {
            'data-color': attributes.color,
            style: `background-color: ${attributes.color}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'mark',
      },
      {
        tag: 'span',
        getAttrs: element => {
          const hasHighlight = 
            (element as HTMLElement).style.backgroundColor ||
            (element as HTMLElement).hasAttribute('data-color') ||
            (element as HTMLElement).classList.contains('highlight');
          
          if (!hasHighlight) {
            return false;
          }

          return {};
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'mark',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      0,
    ];
  },

  addCommands() {
    return {
      setHighlight:
        (attributes) =>
        ({ commands }) => {
          return commands.setMark(this.name, attributes);
        },
      toggleHighlight:
        (attributes) =>
        ({ commands }) => {
          return commands.toggleMark(this.name, attributes);
        },
      unsetHighlight:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name);
        },
    };
  },
}); 