import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The agent was TOLD not to use the `question` tool:
//
//   "The built-in `question` tool is DISABLED in Slack (it is a synchronous
//    web-UI construct with no answerer in a thread); calling it just fails."
//
// It is not disabled and it does not fail. `postQuestion` / `postTeamsQuestion`
// post the blocks or the card and return AT ONCE with a sentinel telling the
// agent to end its turn. The stale line is why a request for clickable
// questions came back as a numbered list of prose the user could not tap,
// while `/models` in the same conversation rendered real buttons.
//
// A static read: these are prompt strings, and the point is what the agent is
// told, not what a function returns.

const root = join(import.meta.dir, '../..');
const teams = readFileSync(join(root, 'src/channels/teams/session.ts'), 'utf8');
const slack = readFileSync(join(root, 'src/channels/slack/session.ts'), 'utf8');
const teamsQuestions = readFileSync(join(root, 'src/channels/teams/questions.ts'), 'utf8');
const slackQuestions = readFileSync(join(root, 'src/channels/slack/questions.ts'), 'utf8');

const instructionsOf = (source: string) => {
  const start = source.indexOf('TURN_INSTRUCTIONS = [');
  expect(start, 'TURN_INSTRUCTIONS is missing').toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('].join(', start));
};

// SLACK points at the tool. TEAMS must not, and the difference is not
// cosmetic: releasing opencode's blocking `question` call is gated on a
// channel context that, until the daemon fix in this change, read
// SLACK_THREAD_TS / SLACK_CHANNEL_ID only. A Teams session fell through to
// "left open for the UI" and the agent hung — after the card had been posted,
// because the relay is ungated. Flip Teams over only once sandboxes carry the
// fixed daemon; the agent server is image-baked.
describe('slack turn instructions', () => {
  const block = instructionsOf(slack);

  test('never calls the question tool disabled or broken', () => {
    expect(block).not.toMatch(/`question` tool is DISABLED/);
  });

  test('points the agent at the question tool for discrete choices', () => {
    expect(block).toMatch(/built-in `question`/);
    expect(block).toMatch(/DISCRETE choices/);
  });

  test('still tells the agent to END its turn — the answer is a new turn', () => {
    expect(block).toMatch(/END your turn/);
  });

  test('keeps `send` for genuinely open-ended questions only', () => {
    expect(block).toMatch(/open-ended/);
  });
});

describe('teams turn instructions', () => {
  const block = instructionsOf(teams);

  test('tells the agent NOT to use the question tool, and why', () => {
    expect(block).toMatch(/Do NOT use the built-in `question` tool in Teams/);
    expect(block).toMatch(/hangs/);
  });

  test('points at `teams send` instead, and still ends the turn', () => {
    expect(block).toMatch(/Use `teams send`/);
    expect(block).toMatch(/END your turn/);
  });
});

describe('the relay the instructions describe actually behaves that way', () => {
  test.each([
    ['teams', teamsQuestions],
    ['slack', slackQuestions],
  ])('%s returns a sentinel telling the agent to finish now', (_name, source) => {
    // If this ever starts blocking, the instruction above becomes a lie.
    expect(source).toMatch(/finish this turn now/);
    expect(source).toMatch(/QUESTION_SENTINEL/);
  });
});
