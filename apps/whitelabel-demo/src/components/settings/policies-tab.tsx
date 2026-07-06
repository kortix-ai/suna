'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Shield, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

type PolicyAction = 'always_run' | 'require_approval' | 'block';
type DefaultMode = 'risk' | 'allow_all';

const ACTIONS: PolicyAction[] = ['always_run', 'require_approval', 'block'];

interface Rule {
  match: string;
  action: PolicyAction;
}

function actionVariant(a: PolicyAction) {
  if (a === 'block') return 'destructive' as const;
  if (a === 'require_approval') return 'secondary' as const;
  return 'default' as const;
}

export function PoliciesTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['project-policies', projectId] as const;

  const policies = useQuery({
    queryKey: key,
    queryFn: () => kortix.project(projectId).policies.list(),
  });

  const [rules, setRules] = useState<Rule[]>([]);
  const [defaultMode, setDefaultMode] = useState<DefaultMode>('risk');
  const [newMatch, setNewMatch] = useState('');
  const [newAction, setNewAction] = useState<PolicyAction>('require_approval');

  // Seed local editable state from the server whenever a fresh listing arrives.
  useEffect(() => {
    const data = policies.data;
    if (!data) return;
    setRules(data.policies.map((p) => ({ match: p.match, action: p.action })));
    setDefaultMode(data.defaultMode);
  }, [policies.data]);

  const save = useMutation({
    mutationFn: () =>
      kortix.project(projectId).policies.set(
        rules.filter((r) => r.match.trim()),
        defaultMode,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      toast.success('Policies saved');
    },
    onError: () => toast.error('Could not save policies'),
  });

  const addRule = () => {
    if (!newMatch.trim()) return;
    setRules((r) => [...r, { match: newMatch.trim(), action: newAction }]);
    setNewMatch('');
  };

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Shield className="size-4 text-muted-foreground" /> Tool policies
        </div>
        <p className="text-xs text-muted-foreground">
          Decide which tool calls run automatically, need approval, or are blocked.
        </p>
        <Separator className="my-4" />
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label>Default mode</Label>
            <p className="text-xs text-muted-foreground">How unmatched tool calls are handled.</p>
          </div>
          <Select value={defaultMode} onValueChange={(v) => setDefaultMode(v as DefaultMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="risk">By risk</SelectItem>
              <SelectItem value="allow_all">Allow all</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card className="p-0">
        <div className="px-5 pt-5 text-sm font-medium">Rules</div>
        <div className="mt-2 divide-y divide-border">
          {policies.isLoading && (
            <div className="p-4">
              <Skeleton className="h-5 w-40" />
            </div>
          )}
          {policies.isSuccess && rules.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No rules — the default mode applies to everything.
            </div>
          )}
          {rules.map((r, i) => (
            <div key={i} className="flex items-center gap-2 px-4 py-3">
              <Input
                value={r.match}
                onChange={(e) =>
                  setRules((prev) =>
                    prev.map((p, j) => (j === i ? { ...p, match: e.target.value } : p)),
                  )
                }
                placeholder="glob, e.g. shell.*"
                className="font-mono"
              />
              <Select
                value={r.action}
                onValueChange={(v) =>
                  setRules((prev) =>
                    prev.map((p, j) => (j === i ? { ...p, action: v as PolicyAction } : p)),
                  )
                }
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTIONS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge variant={actionVariant(r.action)} className="hidden sm:inline-flex">
                {r.action}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-destructive"
                onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove rule"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Input
            value={newMatch}
            onChange={(e) => setNewMatch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addRule();
              }
            }}
            placeholder="Add a match pattern…"
            className="font-mono"
          />
          <Select value={newAction} onValueChange={(v) => setNewAction(v as PolicyAction)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={addRule} aria-label="Add rule">
            <Plus className="size-4" />
          </Button>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />}
          Save policies
        </Button>
      </div>
    </div>
  );
}
