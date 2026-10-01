'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// Inline JSON Tree View
// ---------------------------------------------------------------------------

export function JsonTreeView({ content }: { content: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const parsed = useMemo(() => {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }, [content]);

  if (parsed === null) {
    return (
      <div className="text-destructive/70 p-4 font-mono text-sm">
        {tHardcodedUi.raw('featuresFilesComponentsFileContentRenderer.line915JsxTextInvalidJson')}
      </div>
    );
  }

  return (
    <div className="p-4 font-mono text-sm leading-relaxed">
      <JsonNode value={parsed} keyName={null} depth={0} />
    </div>
  );
}

function JsonNode({
  value,
  keyName,
  depth,
}: {
  value: unknown;
  keyName: string | null;
  depth: number;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [isCollapsed, setIsCollapsed] = useState(depth > 2);

  if (value === null) {
    return (
      <div style={{ paddingLeft: depth * 20 }}>
        {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
        <span className="text-muted-foreground/50 italic">
          {tHardcodedUi.raw('i18nComplete.text74234e98afe7')}
        </span>
      </div>
    );
  }

  if (typeof value === 'boolean') {
    return (
      <div style={{ paddingLeft: depth * 20 }}>
        {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
        <span className="text-kortix-yellow">{String(value)}</span>
      </div>
    );
  }

  if (typeof value === 'number') {
    return (
      <div style={{ paddingLeft: depth * 20 }}>
        {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
        <span className="text-kortix-blue">{String(value)}</span>
      </div>
    );
  }

  if (typeof value === 'string') {
    const isUrl = /^https?:\/\//.test(value);
    return (
      <div style={{ paddingLeft: depth * 20 }} className="break-all">
        {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
        <span className="text-kortix-green">
          {tHardcodedUi.raw('featuresFilesComponentsFileContentRenderer.line963JsxTextQuot')}
          {value.length > 200 ? value.slice(0, 200) + '...' : value}
          {tHardcodedUi.raw(
            'featuresFilesComponentsFileContentRenderer.line963JsxTextQuotb4125902',
          )}
        </span>
        {isUrl && (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-kortix-blue/70 hover:text-kortix-blue ml-1 text-xs"
          >
            {tHardcodedUi.raw('i18nComplete.text2348f9987442')}
          </a>
        )}
      </div>
    );
  }

  if (Array.isArray(value)) {
    const count = value.length;
    return (
      <div>
        <button
          type="button"
          style={{ paddingLeft: depth * 20 }}
          aria-expanded={!isCollapsed}
          className="hover:bg-muted/30 inline-flex cursor-pointer items-center gap-1 rounded-sm text-left transition-colors"
          onClick={() => setIsCollapsed((v) => !v)}
        >
          <span className="text-muted-foreground/40 w-3.5 text-center text-xs select-none">
            {isCollapsed ? '\u25B6' : '\u25BC'}
          </span>
          {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
          {isCollapsed ? (
            <span className="text-muted-foreground/40">
              [{count} {tHardcodedUi.raw('i18nComplete.text4a33eacd5fa6')}
              {count !== 1 ? 's' : ''}]
            </span>
          ) : (
            <span className="text-muted-foreground/30">[</span>
          )}
        </button>
        {!isCollapsed && (
          <>
            {value.map((item, idx) => (
              <JsonNode key={idx} value={item} keyName={null} depth={depth + 1} />
            ))}
            <div style={{ paddingLeft: depth * 20 }} className="text-muted-foreground/30">
              ]
            </div>
          </>
        )}
      </div>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const count = entries.length;
    return (
      <div>
        <button
          type="button"
          style={{ paddingLeft: depth * 20 }}
          aria-expanded={!isCollapsed}
          className="hover:bg-muted/30 inline-flex cursor-pointer items-center gap-1 rounded-sm text-left transition-colors"
          onClick={() => setIsCollapsed((v) => !v)}
        >
          <span className="text-muted-foreground/40 w-3.5 text-center text-xs select-none">
            {isCollapsed ? '\u25B6' : '\u25BC'}
          </span>
          {keyName !== null && <span className="text-primary/70">{`"${keyName}"`}: </span>}
          {isCollapsed ? (
            <span className="text-muted-foreground/40">
              {'{' + count + ' key' + (count !== 1 ? 's' : '') + '}'}
            </span>
          ) : (
            <span className="text-muted-foreground/30">{'{'}</span>
          )}
        </button>
        {!isCollapsed && (
          <>
            {entries.map(([k, v]) => (
              <JsonNode key={k} value={v} keyName={k} depth={depth + 1} />
            ))}
            <div style={{ paddingLeft: depth * 20 }} className="text-muted-foreground/30">
              {'}'}
            </div>
          </>
        )}
      </div>
    );
  }

  return null;
}
