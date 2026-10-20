'use client';

import { useTranslations } from '@/i18n/use-translations';
import {
  type AdminConnector,
  type ConnectorPolicyAction,
  type ConnectorPolicyRule,
} from '@kortix/sdk';
import { PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

import {
  draftToRules,
  type PatternDraftRow,
  seedPatternDraft,
  signPatternRules,
} from '@/features/workspace/capabilities/connectors/tools/pattern-rule-draft';
import { POLICY_CHOICE_LABEL } from '@/features/workspace/capabilities/connectors/tools/tool-policy-labels';

const PATTERN_ACTIONS: ConnectorPolicyAction[] = ['block', 'require_approval', 'always_run'];
let patternRowSequence = 0;
function nextPatternRowId() {
  return `pattern:${++patternRowSequence}`;
}
export function ConnectorAdvancedTools({
  connector,
  advancedRules,
  toolRules,
  loaded,
  frozen,
  busy,
  saving,
  sensitivePending,
  onSave,
  onSensitive,
}: {
  connector: AdminConnector;
  advancedRules: ConnectorPolicyRule[];
  toolRules: ConnectorPolicyRule[];
  loaded: boolean;
  frozen: boolean;
  busy: boolean;
  saving: boolean;
  sensitivePending: boolean;
  onSave: (rules: ConnectorPolicyRule[]) => void;
  onSensitive: (next: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const hasTools = connector.actions.length > 0;
  // ── Advanced: pattern rules ─────────────────────────────────────────────
  const advancedSignature = useMemo(() => signPatternRules(advancedRules), [advancedRules]);
  const [draft, setDraft] = useState<PatternDraftRow[]>([]);
  // Reseed only when the SERVER's pattern set actually changes. A per-tool
  // write invalidates the same query, and reseeding on every refetch would
  // wipe a half-typed rule out from under the user.
  //
  // `signPatternRules` normalizes through `orderPolicyRules` before comparing,
  // because the optimistic write at `onMutate` reorders the very array this
  // guard reads. Without that, one click on any per-tool segment moved the
  // rules, changed the signature, and reseeded — see `pattern-rule-draft.ts`.
  const seededSignature = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (seededSignature.current === advancedSignature) return;
    seededSignature.current = advancedSignature;
    setDraft(seedPatternDraft(advancedRules, nextPatternRowId));
  }, [loaded, advancedSignature, advancedRules]);

  const draftSignature = signPatternRules(draftToRules(draft));
  const advancedDirty = draftSignature !== advancedSignature;

  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Reveal existing pattern rules ONCE, when they first arrive from the policies
  // query — not on every change to their count. Keyed on the count alone, this
  // re-fired whenever a rule was added or removed, so the panel sprang back open
  // moments after the user collapsed it, which read as the disclosure opening by
  // itself. After the first reveal the panel is the user's to control.
  const revealedExistingRules = useRef(false);
  useEffect(() => {
    if (revealedExistingRules.current || advancedRules.length === 0) return;
    revealedExistingRules.current = true;
    setAdvancedOpen(true);
  }, [advancedRules.length]);

  const savePatternRules = () => onSave([...toolRules, ...draftToRules(draft)]);

  return (
    <>
      {hasTools || advancedRules.length > 0 ? (
        <Disclosure
          variant="outline"
          className="overflow-hidden"
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
        >
          <DisclosureTrigger variant="outline">
            <Button variant="popover">
              {tI18nComplete.raw('text9f088dbebd6c')}
              {advancedRules.length > 0 ? (
                <Badge variant="secondary" size="sm">
                  {advancedRules.length}
                </Badge>
              ) : null}
              <span className="text-muted-foreground ml-auto text-xs font-normal">
                {tI18nComplete.raw('text59da2efb2423')}
              </span>
            </Button>
          </DisclosureTrigger>
          <DisclosureContent variant="outline" contentClassName="border-border border-t">
            <div className="space-y-5 px-4 py-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-foreground text-sm font-medium">
                    {tI18nComplete.raw('text594bdd4c19b2')}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                    {tI18nComplete.raw('textf900377c2048')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {sensitivePending ? <Loading className="size-4 shrink-0" /> : null}
                  <Switch
                    checked={connector.sensitive === true}
                    onCheckedChange={onSensitive}
                    disabled={frozen || sensitivePending}
                    aria-label={tI18nComplete.raw('text594bdd4c19b2')}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{tI18nComplete.raw('text380c0b05bcfc')}</Label>
                <p className="text-muted-foreground text-xs text-pretty">
                  {tI18nComplete.raw('textde00adeaf21b')}
                  <code className="font-mono">delete_*</code>
                  {tI18nComplete.raw('text3a13855164e7')}
                  <code className="font-mono">/^send/i</code>
                  {tI18nComplete.raw('texte45481e75a5e')}
                </p>
                {draft.map((row) => (
                  <div key={row.id} className="flex items-center gap-2">
                    <Input
                      value={row.match}
                      placeholder={tI18nComplete.raw('text74ad536dca05')}
                      variant="popover"
                      size="xs"
                      className="flex-1 font-mono"
                      aria-label={tI18nComplete.raw('text5c9c672f4cd3')}
                      disabled={frozen}
                      onChange={(event) =>
                        setDraft((rows) =>
                          rows.map((candidate) =>
                            candidate.id === row.id
                              ? { ...candidate, match: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                    />
                    <Select
                      value={row.action}
                      disabled={frozen}
                      onValueChange={(next) =>
                        setDraft((rows) =>
                          rows.map((candidate) =>
                            candidate.id === row.id
                              ? {
                                  ...candidate,
                                  action:
                                    next === 'block' || next === 'always_run'
                                      ? next
                                      : 'require_approval',
                                }
                              : candidate,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="h-8 w-[104px] shrink-0 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      {/* Three, not four: a stored rule always names an action.
                        "Default" for a pattern means deleting it, which is
                        what the trash button beside this does. */}
                      <SelectContent className="rounded-lg">
                        {PATTERN_ACTIONS.map((action) => (
                          <SelectItem key={action} value={action} className="text-xs">
                            {POLICY_CHOICE_LABEL[action]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="hover:text-destructive size-8 shrink-0"
                      aria-label={tI18nComplete('texte2cbd4618228', {
                        value0: row.match || '(empty)',
                      })}
                      disabled={frozen}
                      onClick={() =>
                        setDraft((rows) => rows.filter((candidate) => candidate.id !== row.id))
                      }
                    >
                      <TrashIcon className="size-3.5 shrink-0" />
                    </Button>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 text-xs"
                    disabled={frozen}
                    onClick={() =>
                      setDraft((rows) => [
                        ...rows,
                        { id: nextPatternRowId(), match: '', action: 'require_approval' },
                      ])
                    }
                  >
                    <PlusIcon className="size-3.5 shrink-0" />
                    {tI18nComplete.raw('texta27cff51a2e0')}
                  </Button>
                  {advancedDirty ? (
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline-ghost"
                        className="h-8 text-xs"
                        disabled={busy}
                        onClick={() => setDraft(seedPatternDraft(advancedRules, nextPatternRowId))}
                      >
                        {tI18nComplete.raw('texteb1a70e39274')}
                      </Button>
                      <Button
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        disabled={frozen || busy}
                        onClick={savePatternRules}
                      >
                        {saving ? <Loading className="size-3.5 shrink-0" /> : null}
                        {tI18nComplete.raw('texte5dbdffb8816')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </DisclosureContent>
        </Disclosure>
      ) : null}
    </>
  );
}
