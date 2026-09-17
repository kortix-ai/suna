/**
 * project-greeting — the one sentence on an empty project surface.
 *
 * "Give {project name} something real to work on." is web's
 * `HOME_GREETINGS[0]` (apps/web/src/features/workspace/project-layout/home/
 * home-greeting.ts). Web rotates six variants per visit. Mobile shows this one
 * on every visit (COR-34). `project-greeting.test.ts` pins the two apps
 * together.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */

export const PROJECT_GREETING = {
  before: 'Give',
  after: 'something real to work on.',
} as const;

/**
 * The name slot. One word while the name is unknown, as on web: "this project"
 * would be a description wearing the name's highlight.
 */
export function projectGreetingName(projectName: string | null | undefined): string {
  return projectName?.trim() || 'it';
}

/** The whole sentence as plain text. */
export function projectGreeting(projectName: string | null | undefined): string {
  return `${PROJECT_GREETING.before} ${projectGreetingName(projectName)} ${PROJECT_GREETING.after}`;
}
