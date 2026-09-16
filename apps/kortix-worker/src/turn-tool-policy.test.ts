import { expect, test } from "bun:test";
import { TurnAdmissionJournal, type TurnAdmission } from "./turn-journal.ts";
import type { SessionLogItem } from "./session-store.ts";

test("tool controls follow started turns, replace earlier controls, and survive restoration", async () => {
  const items: SessionLogItem[] = [];
  const log = {
    read: async () => structuredClone(items),
    append: async (item: SessionLogItem) => {
      items.push(structuredClone(item));
    },
  };
  let journal = await TurnAdmissionJournal.open(log);
  const admit = async (id: string, tools?: Record<string, boolean>) => {
    const turn: TurnAdmission = {
      messageId: id,
      text: id,
      options: tools === undefined ? {} : { tools },
      wireUserMessage: { info: { id, role: "user" }, parts: [] },
    };
    expect(await journal.accept(turn)).toBe(true);
  };
  expect(journal.toolControls).toEqual({});
  await admit("msg_1", { bash: false });
  expect(journal.toolControls).toEqual({});
  expect(await journal.start("msg_1")).toBe(true);
  expect(journal.toolControls).toEqual({ bash: false });
  expect(await journal.complete("msg_1", [], "idle")).toBe(true);
  await admit("msg_2", { bash: true });
  expect(await journal.cancel("msg_2")).toBe(true);
  expect(journal.toolControls).toEqual({ bash: false });
  for (const [id, tools] of [
    ["msg_3", undefined],
    ["msg_4", {}],
  ] as const) {
    await admit(id, tools);
    expect(await journal.start(id)).toBe(true);
    expect(await journal.complete(id, [], "idle")).toBe(true);
    expect(journal.toolControls).toEqual({ bash: false });
  }
  await admit("msg_5", { read: false });
  expect(await journal.start("msg_5")).toBe(true);
  expect(journal.toolControls).toEqual({ read: false });
  journal = await TurnAdmissionJournal.open(log);
  expect(journal.toolControls).toEqual({ read: false });
  journal.toolControls.read = true;
  expect(journal.toolControls).toEqual({ read: false });
});
