'use client';

import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDemoConversation, type DemoConversation } from '../chat/use-demo-conversation';
import { defaultDemoPage, isDemoPageEnabled } from '../page-flags';
import type { ActiveModel, PageId, ProjectCard, ProjectStatus } from '../types';
import { CHAT_PROMPT, DEFAULT_MODEL, SCRIPT, SETTLED, type Beat, type DirectorApi } from './script';
import { cmdLine, type Line } from './terminal';

/** One rendered terminal entry: the typed command + the output streamed under it. */
export type Block = { cmd: Line; out: Line[]; note?: boolean };

export type DemoDirector = {
  /* web-synced state — the pages render from these */
  activePage: PageId;
  projects: ProjectCard[];
  activeModel: ActiveModel;
  connectedProviders: string[];
  connectors: string[];
  scheduleAdded: boolean;
  secretAdded: boolean;
  memberAdded: boolean;
  slack: { connected: boolean; workspace: string | null };
  convo: DemoConversation;

  /* terminal state — the floating CLI renders from these */
  scrollback: Block[];
  typed: string;
  typingNote: boolean;
  running: boolean;

  /* controls */
  navigate: (page: PageId) => void;
  start: () => void;
  pauseForUser: () => void;
};

/** Pacing for the typewriter + line streaming (ms). Mirrors cli-demo.tsx. */
const SPEED = {
  start: 420,
  type: 34,
  afterType: 240,
  afterFlush: 110,
  line: 90,
  afterStep: 440,
  hold: 2400,
  afterClear: 600,
};

/** Pre-flattened scrollback for reduced motion — every command's `out` lines. */
const STATIC_BLOCKS: Block[] = SCRIPT.map((cmd) => ({
  cmd: cmdLine(cmd.input, cmd.note),
  note: cmd.note,
  out: cmd.beats
    .filter((b): b is Extract<Beat, { kind: 'out' }> => b.kind === 'out')
    .map((b) => b.line),
}));

export function useDemoDirector(): DemoDirector {
  const reduced = useReducedMotion();

  const [activePage, setActivePage] = useState<PageId>(defaultDemoPage);
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [activeModel, setActiveModel] = useState<ActiveModel>(DEFAULT_MODEL);
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<string[]>([]);
  const [scheduleAdded, setScheduleAdded] = useState(false);
  const [secretAdded, setSecretAdded] = useState(false);
  const [memberAdded, setMemberAdded] = useState(false);
  const [slack, setSlack] = useState<{ connected: boolean; workspace: string | null }>({
    connected: false,
    workspace: null,
  });

  const [scrollback, setScrollback] = useState<Block[]>([]);
  const [typed, setTyped] = useState('');
  const [typingNote, setTypingNote] = useState(false);

  const [started, setStarted] = useState(false);
  const [interacted, setInteracted] = useState(false);

  const convo = useDemoConversation({ onEnterChat: () => setActivePage('chat') });

  // Keep a live handle to convo for the async loop (its `submit` identity churns
  // with the draft, so we read it through a ref instead of an effect dependency).
  const convoRef = useRef<DemoConversation>(convo);
  useEffect(() => {
    convoRef.current = convo;
  });

  /* The effect surface the script's `fx`/`nav` beats drive. All setters are
   * stable, chat goes through the ref — so the whole API is created once. */
  const api = useMemo<DirectorApi>(
    () => ({
      nav: (page) => {
        if (isDemoPageEnabled(page)) setActivePage(page);
      },
      addProject: (project) => setProjects((prev) => [...prev, project]),
      patchProject: (name, patch) =>
        setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, ...patch } : p))),
      setProjectStatus: (name, status: ProjectStatus) =>
        setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, status } : p))),
      connectConnector: (name) =>
        setConnectors((prev) => (prev.includes(name) ? prev : [...prev, name])),
      connectProvider: (domain) =>
        setConnectedProviders((prev) => (prev.includes(domain) ? prev : [...prev, domain])),
      setModel: (model) => setActiveModel(model),
      addSchedule: () => setScheduleAdded(true),
      addSecret: () => setSecretAdded(true),
      inviteMember: () => setMemberAdded(true),
      connectSlack: (workspace) => setSlack({ connected: true, workspace }),
      runChat: (prompt) => convoRef.current.submit(prompt),
    }),
    [],
  );

  const resetState = useCallback(() => {
    setScrollback([]);
    setProjects([]);
    setActiveModel(DEFAULT_MODEL);
    setConnectedProviders([]);
    setConnectors([]);
    setScheduleAdded(false);
    setSecretAdded(false);
    setMemberAdded(false);
    setSlack({ connected: false, workspace: null });
    convoRef.current.reset();
  }, []);

  // Manually switching tabs just changes the page — it does NOT stop the movie.
  // The CLI keeps typing + looping, and its next `nav` beat re-asserts control.
  const navigate = useCallback((page: PageId) => {
    if (isDemoPageEnabled(page)) setActivePage(page);
  }, []);

  // Only a real takeover (typing your own prompt into a composer) pauses the loop
  // so the CLI doesn't hijack the chat the visitor just started.
  const pauseForUser = useCallback(() => {
    setInteracted(true);
    setTyped('');
  }, []);

  const start = useCallback(() => setStarted(true), []);

  /* Reduced motion: skip the movie, render the settled end state once. */
  useEffect(() => {
    if (!reduced) return;
    setScrollback(STATIC_BLOCKS);
    setProjects(SETTLED.projects);
    setActiveModel(SETTLED.model);
    setConnectedProviders(SETTLED.connectedProviders);
    setConnectors(SETTLED.connectors);
    setScheduleAdded(SETTLED.scheduleAdded);
    setSecretAdded(SETTLED.secretAdded);
    setMemberAdded(SETTLED.memberAdded);
    setSlack(SETTLED.slack);
    convoRef.current.submit(CHAT_PROMPT); // finalizes instantly under reduced motion
    setActivePage('channels');
  }, [reduced]);

  /* The movie: type each command, stream its beats, loop. */
  useEffect(() => {
    if (!started || reduced || interacted) return;
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const sleep = (ms: number) =>
      new Promise<void>((res) => {
        const id = setTimeout(() => {
          timers.delete(id);
          res();
        }, ms);
        timers.add(id);
      });

    const appendLine = (line: Line) =>
      setScrollback((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last) next[next.length - 1] = { ...last, out: [...last.out, line] };
        return next;
      });

    async function runBeats(beats: Beat[]) {
      for (const b of beats) {
        if (cancelled) return;
        if (b.kind === 'out') {
          appendLine(b.line);
          await sleep(SPEED.line);
        } else if (b.kind === 'nav') {
          api.nav(b.page);
        } else if (b.kind === 'fx') {
          b.run(api);
        } else {
          await sleep(b.ms);
        }
      }
    }

    async function run() {
      resetState();
      setTyped('');
      setTypingNote(false);
      await sleep(SPEED.start);
      while (!cancelled) {
        for (const cmd of SCRIPT) {
          if (cancelled) return;
          setTypingNote(!!cmd.note);
          for (let i = 1; i <= cmd.input.length; i += 1) {
            if (cancelled) return;
            setTyped(cmd.input.slice(0, i));
            await sleep(SPEED.type);
          }
          await sleep(SPEED.afterType);
          if (cancelled) return;
          setScrollback((prev) => [
            ...prev,
            { cmd: cmdLine(cmd.input, cmd.note), out: [], note: cmd.note },
          ]);
          setTyped('');
          setTypingNote(false);
          await sleep(SPEED.afterFlush);
          await runBeats(cmd.beats);
          await sleep(SPEED.afterStep);
        }
        await sleep(SPEED.hold);
        if (cancelled) return;
        resetState();
        api.nav('projects');
        await sleep(SPEED.afterClear);
      }
    }

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [started, reduced, interacted, api, resetState]);

  return {
    activePage,
    projects,
    activeModel,
    connectedProviders,
    connectors,
    scheduleAdded,
    secretAdded,
    memberAdded,
    slack,
    convo,
    scrollback,
    typed,
    typingNote,
    running: started && !reduced && !interacted,
    navigate,
    start,
    pauseForUser,
  };
}
