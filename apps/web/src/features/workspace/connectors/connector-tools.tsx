'use client';

import type { ConnectorAction, ConnectorPolicyAction } from '@kortix/sdk';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

import { POLICY_CHOICES, POLICY_LABEL, PermissionPicker, type PolicyChoice } from './policy-picker';
import { filterTools, groupPolicy, toolGroups, toolLabel } from './tool-groups';

/**
 * Hand-picked multi-select over the tool rows.
 *
 * The group-level picker covers "everything that can write" and, because the
 * groups are computed from the SEARCH-FILTERED tools, "everything matching
 * calendar". It does not cover an arbitrary subset — three of seven rows the
 * user points at one by one — so that capability keeps its own affordance.
 * It costs nothing at rest: the row checkbox only appears on hover/focus and
 * the bulk bar only exists once something is selected.
 */
export interface ConnectorToolSelection {
  selected: ReadonlySet<string>;
  onToggle: (path: string) => void;
  /** Select (or clear) every tool currently visible under the search. */
  onSetAll: (paths: string[], select: boolean) => void;
  /** Apply one choice to everything currently selected. */
  onApply: (choice: PolicyChoice) => void;
}

export interface ConnectorToolsProps {
  tools: readonly ConnectorAction[];
  /** Explicit per-tool policies, keyed by `action.path`. Absent means "default". */
  perTool: Record<string, ConnectorPolicyAction>;
  onChange: (path: string, choice: PolicyChoice) => void;
  /** Apply one choice to every tool in a group. */
  onChangeGroup?: (paths: string[], choice: PolicyChoice) => void;
  canWrite?: boolean;
  /**
   * Paths a project-wide rule already decides. Those rows are dimmed so the
   * value never reads as the one currently in force — but they stay editable,
   * because a project rule can be lifted later and staging a connector rule
   * for that is legitimate.
   */
  governedPaths?: ReadonlySet<string>;
  /**
   * Optional expandable panel per tool — the call signature and input schema.
   * Kept out of the default view, one click away for whoever needs it.
   */
  renderToolDetail?: (tool: ConnectorAction) => React.ReactNode;
  /**
   * Optional inline marker rendered before the row's picker — used to say a
   * pattern rule or a project-wide rule already decides this tool, which the
   * picker's own value cannot express.
   */
  renderToolBadge?: (tool: ConnectorAction) => React.ReactNode;
  /** Enables hand-picked multi-select + bulk apply. Requires `canWrite`. */
  selection?: ConnectorToolSelection;
}

/**
 * The tools half of the connector detail screen: every action the connector
 * exposes, split into read-only and write/delete, each with its permission
 * inline.
 *
 * The point is that granting or withholding one tool is a single click here.
 * Pattern rules still exist for the power case, but they live behind the
 * Advanced disclosure below this list rather than being the only way in.
 */
export function ConnectorTools({
  tools,
  perTool,
  onChange,
  onChangeGroup,
  canWrite = false,
  governedPaths,
  renderToolDetail,
  renderToolBadge,
  selection,
}: ConnectorToolsProps) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Both groups start expanded: the whole point of the screen is that you can
  // see what a connector can do without opening anything.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const visible = useMemo(() => filterTools(tools, search), [tools, search]);
  const groups = useMemo(() => toolGroups(visible), [visible]);
  const hasQuery = search.trim().length > 0;
  const selecting = canWrite ? selection : undefined;
  const visiblePaths = useMemo(() => visible.map((t) => t.path), [visible]);
  const selectedCount = selecting?.selected.size ?? 0;
  const allVisibleSelected =
    visiblePaths.length > 0 && visiblePaths.every((p) => selecting?.selected.has(p) === true);

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-foreground text-sm font-medium">Tools</h3>
        {tools.length > 0 && (
          <InputGroupSearch className="max-w-56">
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              variant="popover"
              placeholder="Search tools"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search tools"
            />
          </InputGroupSearch>
        )}
      </div>

      {/* Only exists once the user has picked something — at rest the list is
          just the list. */}
      {selecting && selectedCount > 0 && (
        <div className="border-border bg-muted/30 flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5">
          <span className="text-foreground text-xs font-medium">{selectedCount} selected</span>
          <span className="text-muted-foreground text-xs">Set to</span>
          {POLICY_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => selecting.onApply(c.value)}
              className={cn(
                'hover:bg-muted rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
                c.value === 'default' ? 'text-muted-foreground' : POLICY_LABEL[c.value].tint,
              )}
            >
              {c.label}
            </button>
          ))}
          {!allVisibleSelected && (
            <button
              type="button"
              onClick={() => selecting.onSetAll(visiblePaths, true)}
              className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            >
              Select all {visiblePaths.length}
            </button>
          )}
          {/* Clears the WHOLE selection, not just what the search leaves
              visible. Apply operates on the whole selection, so a
              search-scoped Clear would let you filter, "clear", and then apply
              a policy to tools you believed you had deselected and can no
              longer see. On a permission surface that silently widens access. */}
          <button
            type="button"
            onClick={() => selecting.onSetAll([...selecting.selected], false)}
            className="text-muted-foreground hover:text-foreground ml-auto text-xs transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {tools.length === 0 ? (
        <p className="text-muted-foreground text-sm">This connector exposes no tools yet.</p>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tool matches “{search.trim()}”.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group) => {
            const paths = group.tools.map((t) => t.path);
            const shared = groupPolicy(group.tools, perTool);
            return (
              <Disclosure
                key={group.key}
                open={!collapsed[group.key]}
                onOpenChange={(open) => setCollapsed((prev) => ({ ...prev, [group.key]: !open }))}
                variant="outline"
                className="bg-popover overflow-hidden"
              >
                {/* One child only. DisclosureTrigger clones EVERY child with its
                    own onClick, which would overwrite the bulk control's
                    stopPropagation and collapse the group whenever the picker is
                    used — nesting keeps that handler intact. */}
                <DisclosureTrigger>
                  <div className="flex w-full cursor-pointer items-center gap-2 px-3 py-2">
                    <span className="text-foreground truncate text-sm font-medium">
                      {group.label}
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {group.tools.length}
                    </span>
                    {onChangeGroup && canWrite && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        role="presentation"
                        className="ml-auto shrink-0"
                      >
                        <PermissionPicker
                          value={shared ?? 'default'}
                          onChange={(choice) => onChangeGroup(paths, choice)}
                          label={`Set permission for all ${group.label.toLowerCase()}`}
                        />
                      </div>
                    )}
                  </div>
                </DisclosureTrigger>
                <DisclosureContent contentClassName="border-border border-t">
                  <ul className="divide-border divide-y">
                    {group.tools.map((tool) => {
                      const governed = governedPaths?.has(tool.path) === true;
                      const open = expanded === tool.path;
                      const picked = selecting?.selected.has(tool.path) === true;
                      return (
                        <li
                          key={tool.path}
                          title={tool.path}
                          className={cn('group/tool', picked && 'bg-primary/[0.05]')}
                        >
                          <div className="flex items-start gap-3 px-3 py-2.5">
                            {selecting && (
                              <Checkbox
                                checked={picked}
                                onCheckedChange={() => selecting.onToggle(tool.path)}
                                aria-label={`Select ${toolLabel(tool)}`}
                                className={cn(
                                  'mt-0.5 size-3.5 shrink-0 transition-opacity',
                                  picked
                                    ? ''
                                    : 'opacity-0 group-hover/tool:opacity-100 focus-visible:opacity-100',
                                )}
                              />
                            )}
                            {renderToolDetail ? (
                              <button
                                type="button"
                                onClick={() => setExpanded(open ? null : tool.path)}
                                aria-expanded={open}
                                className="min-w-0 flex-1 text-left"
                              >
                                <ToolRowText tool={tool} />
                              </button>
                            ) : (
                              <div className="min-w-0 flex-1">
                                <ToolRowText tool={tool} />
                              </div>
                            )}
                            {renderToolBadge ? (
                              <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                                {renderToolBadge(tool)}
                              </div>
                            ) : null}
                            <div className={cn('shrink-0 pt-0.5', governed && 'opacity-40')}>
                              <PermissionPicker
                                value={perTool[tool.path] ?? 'default'}
                                onChange={(choice) => onChange(tool.path, choice)}
                                readOnly={!canWrite}
                                label={`Permission for ${toolLabel(tool)}`}
                              />
                            </div>
                          </div>
                          {open && renderToolDetail ? (
                            <div className="bg-muted/20 px-3 pt-1 pb-3">
                              {renderToolDetail(tool)}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </DisclosureContent>
              </Disclosure>
            );
          })}
        </div>
      )}

      {hasQuery && groups.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Showing {visible.length} of {tools.length} tools.
        </p>
      )}
    </section>
  );
}

function ToolRowText({ tool }: { tool: ConnectorAction }) {
  return (
    <>
      <p className="text-foreground truncate text-sm">{toolLabel(tool)}</p>
      {tool.description ? (
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{tool.description}</p>
      ) : null}
    </>
  );
}
