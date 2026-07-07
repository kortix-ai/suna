import { describe, expect, test } from 'bun:test';
import { type MeetTurn, createMeetConversation } from '../channels/meet-conversation';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('meet conversation orchestrator', () => {
  test('coalesces buffered utterances into a single turn after the debounce', async () => {
    const convo = createMeetConversation({ debounceMs: 40, followUpWindowMs: 1_000 });
    const turns: MeetTurn[] = [];
    const send = (text: string) =>
      convo.ingest({ sessionId: 's1', speaker: 'Priya', text, spoken: true, wake: 'kortix', deliver: (t) => turns.push(t) });

    send('Hey Kortix');
    send('what is the status');
    await sleep(15);
    send('of the migration');
    await sleep(100);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('Hey Kortix what is the status of the migration');
    expect(turns[0]!.speaker).toBe('Priya');
  });

  test('ignores ambient chatter with no wake word and no active window', async () => {
    const convo = createMeetConversation({ debounceMs: 30 });
    const turns: MeetTurn[] = [];
    convo.ingest({ sessionId: 's2', speaker: 'A', text: 'ship the migration first', spoken: true, wake: 'kortix', deliver: (t) => turns.push(t) });
    await sleep(80);
    expect(turns).toHaveLength(0);
  });

  test('follow-up window: the next utterance engages WITHOUT repeating the wake word', async () => {
    const convo = createMeetConversation({ debounceMs: 30, followUpWindowMs: 400 });
    const turns: MeetTurn[] = [];
    const deliver = (t: MeetTurn) => turns.push(t);

    convo.ingest({ sessionId: 's3', speaker: 'A', text: 'kortix hello', spoken: true, wake: 'kortix', deliver });
    await sleep(70);
    expect(convo.inFollowUp('s3')).toBe(true);

    convo.ingest({ sessionId: 's3', speaker: 'A', text: 'what about the timeline', spoken: true, wake: 'kortix', deliver });
    await sleep(70);

    expect(turns.map((t) => t.text)).toEqual(['kortix hello', 'what about the timeline']);
  });

  test('once the follow-up window expires, ambient chatter is ignored again', async () => {
    const convo = createMeetConversation({ debounceMs: 30, followUpWindowMs: 40 });
    const turns: MeetTurn[] = [];
    const deliver = (t: MeetTurn) => turns.push(t);

    convo.ingest({ sessionId: 's4', speaker: 'A', text: 'kortix hi', spoken: true, wake: 'kortix', deliver });
    await sleep(150);
    expect(convo.inFollowUp('s4')).toBe(false);

    convo.ingest({ sessionId: 's4', speaker: 'A', text: 'just regular chatter', spoken: true, wake: 'kortix', deliver });
    await sleep(70);

    expect(turns.map((t) => t.text)).toEqual(['kortix hi']);
  });
});
