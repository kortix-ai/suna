'use client';

import { ApiError, type ProjectMemoryPage, type ProjectMemoryPageSummary, type ProjectMemorySource } from '@kortix/sdk';
import { useUpdateProjectMemoryPage } from '@kortix/sdk/react';
import { WarningCircleIcon } from '@phosphor-icons/react';
import {
  EditorContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
} from '@tiptap/react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { InfoBanner } from '../../primitives/info-banner';
import Loading from '../../primitives/loading';
import { successToast } from '../../primitives/toast';
import { docToMarkdown, markdownToDoc, memoryLinkTarget, superscript } from './body-doc';
import { BODY_CLASS, memoryBodyExtensions } from './body-extensions';
import { SourceMark } from './source-mark';

type EditError = 'conflict' | 'tooLarge' | 'secret' | 'readOnly' | 'failed';

const ERROR_BY_CODE: Record<string, EditError> = {
  version_conflict: 'conflict',
  page_too_large: 'tooLarge',
  secret_detected: 'secret',
  layer_read_only: 'readOnly',
};

/** What a source number's view needs: the page's sources and the project. */
const SourcesContext = createContext<{ sources: Map<number, ProjectMemorySource>; projectId: string } | null>(null);

/** A source number: `SourceMark` (its hint, its link) while reading; a plain superscript while editing. */
function SourceNode({ node, editor }: ReactNodeViewProps) {
  const ctx = useContext(SourcesContext);
  const editable = useEditorState({ editor, selector: (state) => state.editor.isEditable });
  const number = Number(node.attrs.number);
  const source = ctx?.sources.get(number);
  return (
    <NodeViewWrapper as="span">
      {!source ? null : editable || !ctx ? (
        <span className={BODY_CLASS.source}>{superscript(number)}</span>
      ) : (
        <SourceMark source={source} projectId={ctx.projectId} />
      )}
    </NodeViewWrapper>
  );
}

/**
 * The page's body, read and edited with one renderer: the reader's look is
 * the editor's, so Edit changes nothing but the caret. While editing: Markdown
 * shortcuts, no toolbar, Cancel and Save under it; Esc cancels, ⌘Enter saves.
 * A link opens while reading: a URL in a new tab, a relative path as the
 * memory page it names. Save sends the version it started from; a page
 * changed meanwhile answers `version_conflict`, and Reload loads it.
 */
export function MemoryBody({
  projectId,
  page,
  pages,
  editing,
  onSelectPage,
  onDone,
  onReload,
}: {
  projectId: string;
  page: ProjectMemoryPage;
  /** The layer's pages: where a relative link goes. */
  pages: readonly ProjectMemoryPageSummary[];
  editing: boolean;
  onSelectPage: (pageId: string) => void;
  onDone: () => void;
  onReload: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const update = useUpdateProjectMemoryPage(projectId);
  const [error, setError] = useState<EditError | null>(null);
  const [initial] = useState(() => markdownToDoc(page.body));
  const [sources] = useState(() => new Map(page.sources.map((source) => [source.number, source])));
  // Handlers bound once by the editor: they read the newest props.
  const latest = useRef<{ save: () => void; cancel: () => void; open: (href: string) => boolean }>({
    save: () => {},
    cancel: () => {},
    open: () => false,
  });

  const editor = useEditor({
    extensions: memoryBodyExtensions({
      known: new Set(sources.keys()),
      view: ReactNodeViewRenderer(SourceNode, { as: 'span' }),
    }),
    content: initial,
    editable: false,
    immediatelyRender: true,
    editorProps: {
      attributes: { class: BODY_CLASS.root, 'aria-label': t('editor.body') },
      handleKeyDown: (view, event) => {
        if (!view.editable) return false;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          latest.current.cancel();
          return true;
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          latest.current.save();
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        click: (view, event) => {
          if (view.editable) return false;
          const anchor = (event.target as HTMLElement).closest('a');
          const href = anchor?.getAttribute('href');
          if (!anchor || !href || anchor.closest('[data-node-view-wrapper]')) return false;
          if (!latest.current.open(href)) return false;
          event.preventDefault();
          return true;
        },
      },
    },
    onUpdate: () => setError(null),
  });

  // Edit turns the same document editable; Cancel puts the page back as it was.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editing);
    if (editing) editor.commands.focus('end', { scrollIntoView: false });
    else editor.commands.setContent(initial, { emitUpdate: false });
  }, [editor, editing, initial]);

  const save = () => {
    if (update.isPending || !editor) return;
    const body = docToMarkdown(editor.getJSON());
    if (body === docToMarkdown(initial)) return onDone();
    update.mutate(
      { pageId: page.page_id, input: { base_version: page.version_no, body } },
      {
        onSuccess: () => {
          successToast(t('editor.saved'));
          onDone();
        },
        onError: (err) => setError((err instanceof ApiError && err.code && ERROR_BY_CODE[err.code]) || 'failed'),
      },
    );
  };
  const open = (href: string) => {
    const target = memoryLinkTarget(href, page.path);
    if (!target) return false;
    if ('url' in target) window.open(target.url, '_blank', 'noopener,noreferrer');
    else {
      const linked = pages.find((p) => p.path === target.path);
      if (linked) onSelectPage(linked.page_id);
    }
    return true;
  };
  useEffect(() => {
    latest.current = { save, cancel: onDone, open };
  });

  return (
    <SourcesContext.Provider value={{ sources, projectId }}>
      <form
        className="flex flex-col gap-4 pt-8"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {!editing && !page.body.trim() ? <p className="text-muted-foreground text-sm">{t('emptyPage')}</p> : null}
        <EditorContent editor={editor} className={!editing && !page.body.trim() ? 'hidden' : undefined} />
        {editing && error === 'conflict' ? (
          <InfoBanner
            tone="warning"
            icon={WarningCircleIcon}
            title={t('editor.conflict')}
            action={
              <Button type="button" variant="outline" size="toolbar" onClick={onReload}>
                {t('editor.reload')}
              </Button>
            }
          />
        ) : editing && error ? (
          <p role="alert" className="text-destructive text-xs">
            {t(`editor.error.${error}`)}
          </p>
        ) : null}
        {editing ? (
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={update.isPending}>
              {t('editor.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={update.isPending} aria-busy={update.isPending || undefined}>
              {update.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('editor.save')}
            </Button>
          </div>
        ) : null}
      </form>
    </SourcesContext.Provider>
  );
}
