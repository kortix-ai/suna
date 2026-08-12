'use client';

/**
 * `ModelsTab` — "which models can this project use".
 *
 * ## What this screen is for
 *
 * Exactly one thing: turning models on and off in the model menu. Everything
 * here is subordinate to that, including the two default scopes, which are
 * settings ABOUT a model that is already on.
 *
 * ## Why the numbers are gone
 *
 * Every row used to carry four lines: the model name, capability glyphs with
 * no legend, its wire id (`anthropic/claude-sonnet-4-5`) with a copy button,
 * and `200K ctx · $3.00 / $15.00 per 1M`. All of it true; almost none of it
 * readable to someone who has never priced a token, which is most people
 * opening a settings tab to choose a model.
 *
 * A row is now the model's name, its default tags, and ONE plain sentence
 * that restates the same facts in words — `Mid cost · reads images · holds
 * about 150,000 words` (`modelPlainSummary` in `utils.ts`). The wire id kept
 * its one real use, pasting it into a config, and moved to a "Copy model ID"
 * item in the row's own menu: one click for the few who need it, no line for
 * everyone who does not.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Switch } from '@/components/ui/switch';
import { Tag } from '@/components/ui/tag';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { cn } from '@/lib/utils';
import {
  useModelDefaults,
  useModelEnablement,
  useProjectModels,
  wireToModelKey,
} from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  FolderSimpleIcon as Folder,
  DotsThreeIcon as MoreHorizontal,
  StarIcon as Star,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';

import { buildModelGroups } from './model-rows';
import { modelPlainSummary } from './utils';
import { Copy } from '@/features/icon/icons/copy';

/**
 * `search` used to be driven by the provider modal's always-on search bar,
 * which JAY-510 deleted (it sat above the tabs and filtered whichever tab
 * happened to be open). Passing `''` would have silently dropped model search,
 * so this tab owns its own input when no host drives one — one search box per
 * thing being searched, instead of one box for three different lists.
 */
export function ModelsTab({
  projectId,
  search: hostSearch,
}: {
  projectId: string;
  search?: string;
}) {
  const [ownSearch, setOwnSearch] = useState('');
  const search = hostSearch ?? ownSearch;
  const ownsSearch = hostSearch === undefined;

  // The SAME server list the session picker renders (`GET /model-picker`), so
  // the two views can never show different models — and each model's `enabled`
  // flag is resolved server-side and enforced by the gateway, so a switch here
  // is the one and only thing deciding whether it appears there.
  const models = useProjectModels(projectId);
  const enablement = useModelEnablement(projectId);
  // Setting the project default from here is what makes the locked row
  // actionable: the only way to turn the default off is to make something else
  // the default, so the control for that belongs on the same screen.
  //
  // This is also the home for the ACCOUNT default ("my default model"). It
  // used to be a button stacked under the session model picker, alongside two
  // other scopes, where nothing on screen said which model held any of them.
  // Here both scopes sit on the row they apply to and each one BADGES the
  // model that currently holds it — see the `Default` / `Your default` tags
  // below. The picker keeps a one-click star for the account default only;
  // this tab is where the scopes are actually managed.
  const defaults = useModelDefaults(projectId);

  const groups = useMemo(() => buildModelGroups(models, search), [models, search]);
  const enabledCount = useMemo(() => models.filter((m) => m.enabled).length, [models]);

  if (models.length === 0) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-foreground text-sm">No models yet</p>
        <p className="text-muted-foreground max-w-xs text-xs text-pretty">
          Add a key on the API keys tab. The models it unlocks show up here.
        </p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
        <p className="text-muted-foreground text-xs">
          {search ? `Nothing matches "${search}"` : 'No models'}
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 pt-3 pb-4">
      {ownsSearch && (
        <InputGroupSearch className="mb-3">
          <InputGroupSearchIcon>
            <Search />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            type="text"
            placeholder="Search models…"
            autoComplete="off"
            value={ownSearch}
            onChange={(event) => setOwnSearch(event.target.value)}
          />
          <InputGroupSearchClear onClick={() => setOwnSearch('')} />
        </InputGroupSearch>
      )}

      {/* The count is a fact about the whole list, so it hides while a search
          is narrowing that list — "8 of 34 are on" beside three search hits
          describes a list that is not on screen. */}
      {!search && (
        <div className="flex items-center justify-between gap-3 px-1 pb-2.5">
          <p className="flex-1" />
          <div className="flex shrink-0 items-center gap-1">
            {!enablement.usingDefaults && (
              <Button
                variant="ghost"
                size="sm"
                disabled={enablement.isUpdating}
                className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
                onClick={() => void enablement.resetToDefaults()}
              >
                Start over
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {groups.map((group) => (
          <div key={group.providerID} className="space-y-2">
            <div className="flex items-center gap-2">
              <ProviderLogo providerID={group.providerID} name={group.providerName} size="small" />
              <span className="text-foreground/70 text-xs font-medium">{group.providerName}</span>
              <span className="text-muted-foreground/40 ml-auto text-xs tabular-nums">
                {group.rows.length}
              </span>
            </div>
            <div className="bg-popover overflow-hidden rounded-md border">
              {group.rows.map(({ model, wireId, isRollingAlias }, i) => {
                const enabled = !!model.enabled;
                // `auto` resolves to this one, so turning it off would break
                // every default request — the server refuses it with a 409.
                // Lock the switch and say why instead of letting the click
                // become a failed action.
                const isProjectDefault = wireId === enablement.defaultModel;
                // `useModelDefaults` builds every scope with `wireToModelKey`,
                // which parks the whole wire id in `modelID` under the `kortix`
                // provider — so comparing `modelID` to this row's `wireId` is
                // the same comparison `isProjectDefault` makes one line up, not
                // a lucky string match.
                const isAccountDefault = defaults.accountDefault?.modelID === wireId;
                const summary = modelPlainSummary({
                  reasoning: model.capabilities?.reasoning,
                  vision: model.capabilities?.vision,
                  outputUsdPerMillion: model.cost?.output,
                  contextTokens: model.contextWindow,
                });
                return (
                  // A plain row, NOT a <label>: it holds three controls (copy
                  // id, set-as-default, the switch) and a label binds to the
                  // FIRST labelable one — the copy button — so "click the row
                  // to toggle" never did what it looked like. Each control
                  // carries its own accessible name instead.
                  <div
                    key={wireId}
                    className={cn(
                      'hover:bg-muted/40 flex items-start gap-3 px-3 py-2.5 transition-colors',
                      i > 0 && 'border-border border-t',
                      !enabled && 'opacity-60',
                    )}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-foreground truncate text-sm">{model.modelName}</span>
                        {/* No capability glyphs. `summary` below already says
                            "reads images" in words; saying it twice — once as
                            a word, once as an icon with no legend anywhere on
                            the screen — is how a row gets noisy. */}
                        {/* Same display name as its pinned snapshots — say which
                            row is the one that rolls forward. "latest" named
                            the alias; "auto-updates" names what it DOES. */}
                        {isRollingAlias && (
                          <Hint label="Always points at the newest version of this model">
                            <Tag>auto-updates</Tag>
                          </Hint>
                        )}
                        {/* Both scopes badge the model that holds them. A
                            "set as default" control with no matching "this one
                            IS the default" is the reason these moved here. */}
                        {isProjectDefault && (
                          <Hint label="New sessions in this project start with this model">
                            <Tag>project default</Tag>
                          </Hint>
                        )}
                        {isAccountDefault && (
                          <Hint label="Your own starting model, in every project">
                            <Tag>your default</Tag>
                          </Hint>
                        )}
                      </div>

                      {summary && <p className="text-muted-foreground text-xs">{summary}</p>}
                    </div>
                    {/*
                      Both default scopes, on the row they apply to.

                      Gated on `enabled` rather than on "is not already the
                      default": a model the project does not OFFER cannot be
                      anyone's default (the server refuses it), but a model that
                      already holds one scope can still be given the other — the
                      old `!isProjectDefault` gate hid the control on exactly the
                      row you would reach for to also make it your own default.

                      A menu rather than two icon buttons: two stars side by side
                      say nothing about which is which, and each item can state
                      its scope in words and carry its own check. It costs the
                      project default a second click; it buys the account default
                      a home and both of them a readable current state.

                      `DropdownMenuContent` resolves its z-index through
                      `useDialogDepth`, so it stacks above the modal this tab
                      lives in without any per-call-site z-index.
                    */}
                    {enabled && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            disabled={defaults.isUpdating}
                            aria-label={`Default settings for ${model.modelName}`}
                            title="Make this a default"
                            className="text-muted-foreground/50 hover:text-foreground hover:bg-muted data-[state=open]:bg-muted data-[state=open]:text-foreground mt-0.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-90">
                          <DropdownMenuItem
                            disabled={isProjectDefault || defaults.isUpdating}
                            onSelect={() => void defaults.setProjectDefault(wireToModelKey(wireId))}
                          >
                            <Folder className="size-3.5" />
                            Start this project&apos;s sessions with it
                            {isProjectDefault && <Check className="ml-auto size-3.5" />}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={isAccountDefault || defaults.isUpdating}
                            onSelect={() => void defaults.setAccountDefault(wireToModelKey(wireId))}
                          >
                            <Star className="size-3.5" />
                            Make it my default everywhere
                            {isAccountDefault && <Check className="ml-auto size-3.5" />}
                          </DropdownMenuItem>
                          {/* The wire id's only home now that it is off the
                              row. It was printed under every model name —
                              `anthropic/claude-sonnet-4-5` on 34 rows, meaning
                              nothing to most readers and needed only by the
                              few about to paste one into a config file. A menu
                              item costs them one click and everyone else
                              nothing. */}
                          <DropdownMenuItem
                            onSelect={() => void navigator.clipboard?.writeText(wireId)}
                          >
                            <Copy className="size-3.5" />
                            Copy model ID
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    <Switch
                      checked={enabled}
                      disabled={enablement.isUpdating || isProjectDefault}
                      aria-label={
                        isProjectDefault
                          ? `${model.modelName} is this project's default model and cannot be turned off`
                          : `Offer ${model.modelName}`
                      }
                      title={
                        isProjectDefault
                          ? 'This project starts every session with this model — pick a different default before turning it off.'
                          : undefined
                      }
                      onCheckedChange={(next) => void enablement.setEnabled(wireId, next)}
                      className="mt-0.5 shrink-0"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
