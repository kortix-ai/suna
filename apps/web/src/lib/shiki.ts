// https://shiki.style/guide/bundles#fine-grained-bundle

import { useEffect, useState } from "react";
import { codeToHtml as shikiCodeToHtml } from "shiki/bundle/web";

const VALID_LANGUAGES = new Set([
  "python",
  "typescript",
  "javascript",
  "jsx",
  "tsx",
  "css",
  "scss",
  "html",
  "json",
  "markdown",
  "yaml",
  "yml",
  "bash",
  "sql",
  "mdx",
  "scss",
  "sass",
  "less",
  "stylus",
  "env",
  "sh",
  "dotenv",
  "text",
  "plaintext",
]);

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  ts: "typescript",
  yml: "yaml",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  py: "python",
  python: "python",
  txt: "text",
  text: "text",
  plaintext: "plaintext",
  postgres: "sql",
  postgresql: "sql",
  psql: "sql",
  mysql: "sql",
  sqlite: "sql",
  sqlite3: "sql",
  mssql: "sql",
  mariadb: "sql",
  plsql: "sql",
  tsql: "sql",
};

const normalizeLanguage = (language: string): string => {
  if (!language || typeof language !== "string") return "javascript";

  const normalizedInput = language.trim().toLowerCase();
  const resolvedLanguage = LANGUAGE_ALIASES[normalizedInput] || normalizedInput;

  return VALID_LANGUAGES.has(resolvedLanguage) ? resolvedLanguage : "javascript";
};

const highlightedCodeCache = new Map<string, string>();
const MAX_HIGHLIGHT_CACHE_SIZE = 200;

export type highlightCodeTheme = "slack-ochin" | "plastic";

const getCacheKey = (code: string, language: string, showBackgroundColors: boolean): string =>
  `${language}::${showBackgroundColors ? "bg" : "no-bg"}::${code}`;

const setCachedHighlightedCode = (key: string, value: string) => {
  // Keep cache bounded to avoid unbounded memory growth in long-lived sessions.
  if (highlightedCodeCache.size >= MAX_HIGHLIGHT_CACHE_SIZE) {
    const oldestKey = highlightedCodeCache.keys().next().value;
    if (oldestKey) {
      highlightedCodeCache.delete(oldestKey);
    }
  }
  highlightedCodeCache.set(key, value);
};

const codeToHtml = async ({
  code,
  language,
  showBackgroundColors = true,
  theme = {
    light: "slack-ochin",
    dark: "plastic",
  },
}: {
  code: string;
  language: string;
  showBackgroundColors?: boolean;
  theme?: {
    light?: highlightCodeTheme;
    dark?: highlightCodeTheme;
  };
}) => {
  const normalizedLanguage = normalizeLanguage(language);
  const cacheKey = getCacheKey(code, normalizedLanguage, showBackgroundColors);
  const cachedHtml = highlightedCodeCache.get(cacheKey);
  if (cachedHtml) return cachedHtml;

  const options = {
    lang: normalizedLanguage,
    themes: theme,
  };

  const html = await shikiCodeToHtml(code, options);
  setCachedHighlightedCode(cacheKey, html);
  return html;
};

const LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  md: "markdown",
  sh: "bash",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  diff: "txt",
};

function getLanguageFromFilename(filename: string): string {
  if (!filename) return "text";

  const extension = filename.split(".").pop()?.toLowerCase() || "";
  const languageFromExtension = LANGUAGE_MAP[extension] || "text";
  return normalizeLanguage(languageFromExtension);
}

const useHighlightedCode = ({
  code,
  language,
  showBackgroundColors = false,
  theme = {
    light: "slack-ochin",
    dark: "plastic",
  },
}: {
  code: string;
  language: string;
  showBackgroundColors?: boolean;
  theme?: {
    light?: highlightCodeTheme;
    dark?: highlightCodeTheme;
  };
}) => {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const highlightCode = async () => {
      if (!code || !isMounted) return;

      // Validate inputs
      if (!language || typeof language !== "string") {
        if (isMounted) {
          setHighlightedHtml(null);
        }
        return;
      }

      try {
        const html = await codeToHtml({ code, language, showBackgroundColors, theme });
        if (isMounted) {
          setHighlightedHtml(html);
        }
      } catch (error) {
        if (isMounted) {
          setHighlightedHtml(null);
        }
      }
    };

    highlightCode();

    return () => {
      isMounted = false;
    };
  }, [code, language, showBackgroundColors]);

  return highlightedHtml;
};

export { getLanguageFromFilename, useHighlightedCode };
