import { defineComponents } from 'blume';

// Blume layout overrides for the docs site. The docs are one page, so the
// left column shows that page's outline instead of a page tree.
export default defineComponents({
  layout: {
    Sidebar: './blume-components/OutlineSidebar.astro',
  },
});
