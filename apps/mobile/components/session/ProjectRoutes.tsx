/**
 * ProjectRoutes — the screens of the stack inside `/projects/[id]`.
 *
 * A project is a stack over one home, so back always has a place to land:
 *   /projects/[id]          index    — project home (greeting, composer)
 *   /projects/[id]/view     view     — every other project state: a tool page
 *                                      (Files, Agents, …), a thread, or a
 *                                      session that is still connecting
 *   /projects/[id]/sessions sessions — every session of the project (drawer)
 *   /projects/[id]/files    files    — the project's files (drawer)
 *   /projects/[id]/account  account  — the Account page (drawer avatar)
 *
 * The stack is never deeper than one screen over project home: `[index]` or
 * `[index, X]`. Every project page shows the hamburger, and the drawer opens
 * on every project route. The drawer pushes `sessions`, `files`, or `account`
 * over home, and replaces a covering route with them
 * (lib/session/project-stack, ProjectScreen). A covering route replaces
 * itself with the view when a session opens (useCoveringRoute).
 *
 * Back: Android back from a covering route returns to project home. iOS has
 * no swipe-back in this stack: the left edge opens the drawer. Back from
 * project home never leaves the project (see ProjectScreen); only the
 * project menu's All projects opens the Projects list.
 *
 * ProjectScreen is the `[id]` layout. It owns the connect engine, the drawer,
 * the sheets and the tab-store scope, and gives home and view their content
 * through ProjectRouteProvider. The tab store still decides WHICH page or
 * thread shows. The routes mirror only whether the project is on its home:
 *   - home route: the store leaves the home state → push `view`
 *   - covering route (sessions, files, account): the store leaves the home
 *     state → replace this route with `view`
 *   - view route: the store returns to the home state (deleted session, New
 *     session) → pop to home
 *   - view route removed (pop, replace, leaving the project) → reset the
 *     store to the home state, before the route leaves the navigation state,
 *     so the home route never sees "not home" with no view to show it
 */

import * as React from 'react';
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type ParamListBase,
} from 'expo-router/react-navigation';
import type { NativeStackNavigationProp } from 'expo-router/build/react-navigation/native-stack';

import type { ProjectSession } from '@/lib/projects/projects-client';
import { PROJECT_VIEW_ROUTE } from '@/lib/session/project-stack';

export {
  PROJECT_ACCOUNT_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_HOME_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  PROJECT_VIEW_ROUTE,
} from '@/lib/session/project-stack';

export interface ProjectRouteValue {
  /** Project home content. */
  home: React.ReactNode;
  /** The open page, thread, or connecting session. Null on project home. */
  view: React.ReactNode;
  /** True when no page, thread, or connecting session is open. */
  isHome: boolean;
  /**
   * Increments each time the view finishes covering project home. The home
   * route remounts on it, so a sent prompt does not wait in the composer.
   */
  homeKey: number;
  /** Return the project to its home state. Stable. */
  goHome: () => void;
  /** The view finished its push transition over project home. Stable. */
  onViewCovered: () => void;
  /** The project this stack shows (the `[id]` route param). */
  projectId: string;
  /**
   * Put the project in the connecting state for a session. The view route
   * shows it. Stable. A covering route opens a session through
   * useCoveringRoute, not through this directly.
   */
  openProjectSession: (session: ProjectSession) => void;
  /** Open the project drawer. Stable. Every project page's hamburger calls it. */
  openDrawer: () => void;
  /** The project drawer is open: a hamburger shows its X. */
  isDrawerOpen: boolean;
}

const ProjectRouteContext = React.createContext<ProjectRouteValue | null>(null);

export const ProjectRouteProvider = ProjectRouteContext.Provider;

/** The project stack's shared content and callbacks. Throws outside ProjectScreen. */
export function useProjectRoute(): ProjectRouteValue {
  const value = React.useContext(ProjectRouteContext);
  if (!value) throw new Error('Project routes render only inside ProjectScreen.');
  return value;
}

// The native stack emits `transitionEnd` from onAppear/onDisappear on both platforms.
type ProjectStackNavigation = NativeStackNavigationProp<ParamListBase>;

/** `/projects/[id]` — project home. */
export function ProjectHomeRoute() {
  const { home, isHome, homeKey } = useProjectRoute();
  const navigation = useNavigation<ProjectStackNavigation>();
  const isFocused = useIsFocused();

  React.useEffect(() => {
    // Only a focused home pushes. While another screen covers home (a
    // covering route, or a root screen such as Billing), nothing moves here.
    if (isHome || !isFocused) return;
    if (navigation.getState().routes.some((route) => route.name === PROJECT_VIEW_ROUTE)) return;
    navigation.dispatch(StackActions.push(PROJECT_VIEW_ROUTE));
  }, [isHome, isFocused, navigation]);

  return <React.Fragment key={homeKey}>{home}</React.Fragment>;
}

/** `/projects/[id]/view` — the open page, thread, or connecting session. */
export function ProjectViewRoute() {
  const { view, isHome, goHome, onViewCovered } = useProjectRoute();
  const navigation = useNavigation<ProjectStackNavigation>();
  const isFocused = useIsFocused();
  // Set once the route is leaving, so the pop below never runs a second time.
  const removingRef = React.useRef(false);

  // The store is back on project home while this route animates out. Keep the
  // last content on screen until the route unmounts.
  const lastViewRef = React.useRef<React.ReactNode>(view);
  if (view) lastViewRef.current = view;

  const callbacksRef = React.useRef({ goHome, onViewCovered });
  callbacksRef.current = { goHome, onViewCovered };

  React.useEffect(() => {
    // Any removal (Android back, New session, a drawer route replacing this
    // one) resets the store before the route leaves the navigation state.
    const offBeforeRemove = navigation.addListener('beforeRemove', () => {
      removingRef.current = true;
      callbacksRef.current.goHome();
    });
    const offTransitionEnd = navigation.addListener('transitionEnd', (event) => {
      if (!event.data.closing) callbacksRef.current.onViewCovered();
    });
    return () => {
      offBeforeRemove();
      offTransitionEnd();
      callbacksRef.current.goHome();
    };
  }, [navigation]);

  React.useEffect(() => {
    if (!isHome || !isFocused || removingRef.current) return;
    removingRef.current = true;
    navigation.goBack();
  }, [isHome, isFocused, navigation]);

  // Tool pages get the hamburger from their PageHeader (pageChrome).
  return <>{lastViewRef.current}</>;
}

/**
 * A route that covers project home: `sessions`, `files`, or `account`. Call it
 * once in the component the route renders: `useNavigation()` there is the
 * project stack.
 *
 * When the store leaves the home state while this route is focused (a session
 * row in the drawer, a notification), the route replaces itself with `view`.
 * No push: the stack stays `[index, view]`.
 *
 * Returns `openSession`, for a session list on the route (Sessions page). It
 * opens once per route instance, and the stack ends as [index, view] with one
 * push transition:
 *   1. openProjectSession(session) — the store leaves the home state first.
 *      Home is not focused (this route covers it), so ProjectHomeRoute does
 *      not push a second view.
 *   2. replace this route with `view` — the view mounts with the store already
 *      off home, so ProjectViewRoute does not pop itself. Replace animates as a
 *      push. No view route is removed, so its `beforeRemove` and unmount
 *      cleanup (both call goHome) never run.
 * The reverse order can mount the view while the store is still home. The view
 * then pops at once and home pushes it again: two transitions.
 *
 * On project home or on the view itself, only the store changes: home pushes
 * the view, and an open view swaps its content. Never replace the view with a
 * new view: the old view's cleanup would reset the store and close the
 * session that just opened.
 *
 * A covering route must not reset the store on `beforeRemove`: replace removes
 * it after step 1.
 */
export function useCoveringRoute(): (session: ProjectSession) => void {
  const { openProjectSession, isHome } = useProjectRoute();
  const navigation = useNavigation<ProjectStackNavigation>();
  const isFocused = useIsFocused();
  // Set once this route starts to leave for the view, so it never dispatches twice.
  const leavingRef = React.useRef(false);

  const replaceWithView = React.useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    navigation.dispatch(StackActions.replace(PROJECT_VIEW_ROUTE));
  }, [navigation]);

  React.useEffect(() => {
    if (isHome || !isFocused) return;
    replaceWithView();
  }, [isHome, isFocused, replaceWithView]);

  return React.useCallback(
    (session: ProjectSession) => {
      if (leavingRef.current) return;
      openProjectSession(session);
      replaceWithView();
    },
    [openProjectSession, replaceWithView]
  );
}
