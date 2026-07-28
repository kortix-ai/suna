'use client';

import type { ConnectorAction, ConnectorPolicyAction } from '@kortix/sdk';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

import { PermissionPicker, type PolicyChoice } from './policy-picker';
import { filterTools, groupPolicy, toolGroups, toolLabel } from './tool-groups';

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
}: ConnectorToolsProps) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Both groups start expanded: the whole point of the screen is that you can
  // see what a connector can do without opening anything.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const visible = useMemo(() => filterTools(tools, search), [tools, search]);
  const groups = useMemo(() => toolGroups(visible), [visible]);
  const hasQuery = search.trim().length > 0;

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

      {tools.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This connector exposes no tools yet.
        </p>
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
                onOpenChange={(open) =>
                  setCollapsed((prev) => ({ ...prev, [group.key]: !open }))
                }
                variant="outline"
                className="bg-popover overflow-hidden"
              >
                <DisclosureTrigger className="px-3 py-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="text-foreground text-sm font-medium">{group.label}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {group.tools.length}
                    </span>
                  </div>
                  {onChangeGroup && canWrite && (
                    <div
                      // The bulk control sits inside the trigger row but must not
                      // toggle the disclosure when used.
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      role="presentation"
                      className="mr-1 shrink-0"
                    >
                      <PermissionPicker
                        value={shared ?? 'default'}
                        onChange={(choice) => onChangeGroup(paths, choice)}
                        label={`Set permission for all ${group.label.toLowerCase()}`}
                      />
                    </div>
                  )}
                </DisclosureTrigger>
                <DisclosureContent contentClassName="border-border border-t">
                  <ul className="divide-border divide-y">
                    {group.tools.map((tool) => {
                      const governed = governedPaths?.has(tool.path) === true;
                      const open = expanded === tool.path;
                      return (
                        <li key={tool.path} title={tool.path}>
                          <div className="flex items-start gap-3 px-3 py-2.5">
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
