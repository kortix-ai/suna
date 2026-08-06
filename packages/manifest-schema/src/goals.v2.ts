/** `kortix_version` 2 durable goal types and validators. */

import { Cron } from 'croner';
import {
  GOAL_METRIC_DIRECTIONS_V2,
  GOAL_STATUSES_V2,
  SLUG_RE,
  goalPushTriggerSlug,
} from './constants';
import { isTable, type ManifestIssue } from './index';

export type GoalStatusV2 = (typeof GOAL_STATUSES_V2)[number];
export type GoalMetricDirectionV2 = (typeof GOAL_METRIC_DIRECTIONS_V2)[number];

export interface GoalMetricV2 {
  name: string;
  direction: GoalMetricDirectionV2;
  target?: number;
  unit?: string;
}

export interface GoalBlockV2 {
  slug: string;
  title: string;
  done_when: string;
  status: GoalStatusV2;
  push?: string;
  timezone?: string;
  agent?: string;
  metrics?: GoalMetricV2[];
}

function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function requireNonEmptyString(
  value: unknown,
  where: string,
  label: string,
  issues: ManifestIssue[],
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({
      path: where,
      message: `${label} is required and may not be empty.`,
      severity: 'error',
    });
    return null;
  }
  return value.trim();
}

function validateGoalMetrics(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined || node === null) return;
  if (!Array.isArray(node)) {
    issues.push({ path, message: 'metrics must be a list.', severity: 'error' });
    return;
  }

  const seenNames = new Set<string>();
  node.forEach((entry, index) => {
    const where = `${path}[${index}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be an object.', severity: 'error' });
      return;
    }

    const name = requireNonEmptyString(entry.name, `${where}.name`, 'name', issues);
    if (name) {
      if (seenNames.has(name)) {
        issues.push({
          path: `${where}.name`,
          message: `duplicate metric name "${name}".`,
          severity: 'error',
        });
      } else {
        seenNames.add(name);
      }
    }

    if (
      typeof entry.direction !== 'string' ||
      !(GOAL_METRIC_DIRECTIONS_V2 as readonly string[]).includes(entry.direction.trim())
    ) {
      issues.push({
        path: `${where}.direction`,
        message: `direction must be one of: ${GOAL_METRIC_DIRECTIONS_V2.join(', ')}.`,
        severity: 'error',
      });
    }
    if (entry.target !== undefined && !isFiniteNumber(entry.target)) {
      issues.push({
        path: `${where}.target`,
        message: 'target must be a number.',
        severity: 'error',
      });
    }
    if (entry.unit !== undefined && (typeof entry.unit !== 'string' || entry.unit.trim() === '')) {
      issues.push({
        path: `${where}.unit`,
        message: 'unit must be a non-empty string.',
        severity: 'error',
      });
    }
  });
}

/** Validate v2 durable goals and their generated-trigger namespace. */
export function validateGoalsV2(
  node: unknown,
  path: string,
  triggerNode: unknown,
  issues: ManifestIssue[],
): void {
  if (node === undefined || node === null) return;
  if (!Array.isArray(node)) {
    issues.push({ path, message: '`goals` must be a YAML list.', severity: 'error' });
    return;
  }

  const explicitTriggerSlugs = new Set<string>();
  if (Array.isArray(triggerNode)) {
    for (const trigger of triggerNode) {
      if (
        isTable(trigger) &&
        typeof trigger.slug === 'string' &&
        SLUG_RE.test(trigger.slug.trim())
      ) {
        explicitTriggerSlugs.add(trigger.slug.trim());
      }
    }
  }

  const seenGoalSlugs = new Set<string>();
  const seenGeneratedSlugs = new Set<string>();
  node.forEach((entry, index) => {
    const where = `${path}[${index}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be an object.', severity: 'error' });
      return;
    }

    const slug = requireNonEmptyString(entry.slug, `${where}.slug`, 'slug', issues);
    const validSlug = slug && SLUG_RE.test(slug);
    if (slug && !validSlug) {
      issues.push({
        path: `${where}.slug`,
        message: `"${slug}" is not a valid slug.`,
        severity: 'error',
      });
    } else if (slug) {
      if (seenGoalSlugs.has(slug)) {
        issues.push({
          path: `${where}.slug`,
          message: `duplicate goal slug "${slug}".`,
          severity: 'error',
        });
      } else {
        seenGoalSlugs.add(slug);
      }
    }

    requireNonEmptyString(entry.title, `${where}.title`, 'title', issues);
    requireNonEmptyString(entry.done_when, `${where}.done_when`, 'done_when', issues);

    const status = typeof entry.status === 'string' ? entry.status.trim() : '';
    if (!(GOAL_STATUSES_V2 as readonly string[]).includes(status)) {
      issues.push({
        path: `${where}.status`,
        message: `status must be one of: ${GOAL_STATUSES_V2.join(', ')}.`,
        severity: 'error',
      });
    }

    let timezone = 'UTC';
    if (entry.timezone !== undefined) {
      if (typeof entry.timezone !== 'string' || entry.timezone.trim() === '') {
        issues.push({
          path: `${where}.timezone`,
          message: 'timezone must be a non-empty IANA string.',
          severity: 'error',
        });
      } else {
        timezone = entry.timezone.trim();
        if (!isValidIanaTimeZone(timezone)) {
          issues.push({
            path: `${where}.timezone`,
            message: `"${entry.timezone}" is not a valid IANA time zone.`,
            severity: 'error',
          });
        }
      }
    }

    let push: string | null = null;
    if (entry.push !== undefined) {
      if (typeof entry.push !== 'string' || entry.push.trim() === '') {
        issues.push({
          path: `${where}.push`,
          message: 'push must be a non-empty cron string.',
          severity: 'error',
        });
      } else {
        push = entry.push.trim();
        if (isValidIanaTimeZone(timezone)) {
          try {
            new Cron(push, { paused: true, timezone });
          } catch (error) {
            issues.push({
              path: `${where}.push`,
              message: `invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
              severity: 'error',
            });
          }
        }
      }
    }

    if (entry.agent !== undefined) {
      if (typeof entry.agent !== 'string' || !SLUG_RE.test(entry.agent.trim())) {
        issues.push({
          path: `${where}.agent`,
          message: 'agent must be a valid non-empty agent slug.',
          severity: 'error',
        });
      }
    }

    validateGoalMetrics(entry.metrics, `${where}.metrics`, issues);

    if (validSlug && status === 'active' && push) {
      const generatedSlug = goalPushTriggerSlug(slug);
      if (explicitTriggerSlugs.has(generatedSlug)) {
        issues.push({
          path: `${where}.push`,
          message: `generated trigger slug "${generatedSlug}" collides with explicit trigger "${generatedSlug}". Rename the explicit trigger.`,
          severity: 'error',
        });
      } else if (seenGeneratedSlugs.has(generatedSlug)) {
        issues.push({
          path: `${where}.push`,
          message: `generated trigger slug "${generatedSlug}" collides with another goal push. Rename this goal.`,
          severity: 'error',
        });
      } else {
        seenGeneratedSlugs.add(generatedSlug);
      }
    }
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
