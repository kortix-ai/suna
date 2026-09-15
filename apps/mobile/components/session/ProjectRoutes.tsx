/**
 * ProjectRoutes — the two screens of the stack inside `/projects/[id]`.
 *
 * A project is two routes, so back always has a place to land:
 *   /projects/[id]        index — project home (greeting, composer, dock)
 *   /projects/[id]/view   view  — every other project state: a tool page
 *                          (Files, Agents, …), a thread, or a session that is
 *                          still connecting
 *
 * Back from the view (the in-app back button, the iOS swipe, the Android back
 * button or gesture) returns to project home. Back from project home never
 * leaves the project (see ProjectScreen); only the project menu's All projects
 * opens the Projects list.
 *
 * ProjectScreen is the `[id]` layout. It owns the connect engine, the drawer,
 * the sheets and the tab-store scope, and gives both routes their content
 * through ProjectRouteProvider. The tab store still decides WHICH page or
 * thread shows. The routes mirror only whether the project is on its home:
 *   - home route: the store leaves the home state → push `view`
 *   - view route: the store returns to the home state (back button, deleted
 *     session) → pop to home
 *   - view route removed (swipe, system back, leaving the project) → reset the
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

import { PageBackProvider } from '@/components/kortix/page-header';

/** Route name of the view screen in the project stack. */
export const PROJECT_VIEW_ROUTE = 'view';

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
  /** The view route mounted (true) or unmounted (false). Stable. */
  onViewOpenChange: (open: boolean) => void;
  /** The view finished its push transition over project home. Stable. */
  onViewCovered: () => void;
}

const ProjectRouteContext = React.createContext<ProjectRouteValue | null>(null);

export const ProjectRouteProvider = ProjectRouteContext.Provider;

function useProjectRoute(): ProjectRouteValue {
  const value = React.useContext(ProjectRouteContext);
  if (!value) throw new Error('Project routes render only inside ProjectScreen.');
  return value;
}

// The JS stack (Android) emits the same `transitionEnd` event as the native
// stack, so one navigation type covers both (see stack-transitions).
type ProjectStackNavigation = NativeStackNavigationProp<ParamListBase>;

/** `/projects/[id]` — project home. */
export function ProjectHomeRoute() {
  const { home, isHome, homeKey } = useProjectRoute();
  const navigation = useNavigation<ProjectStackNavigation>();
  const isFocused = useIsFocused();

  React.useEffect(() => {
    // Only a focused home pushes. While a root screen covers the project
    // (Account), nothing moves; the push happens when the project is back.
    if (isHome || !isFocused) return;
    if (navigation.getState().routes.some((route) => route.name === PROJECT_VIEW_ROUTE)) return;
    navigation.dispatch(StackActions.push(PROJECT_VIEW_ROUTE));
  }, [isHome, isFocused, navigation]);

  return <React.Fragment key={homeKey}>{home}</React.Fragment>;
}

/** `/projects/[id]/view` — the open page, thread, or connecting session. */
export function ProjectViewRoute() {
  const { view, isHome, goHome, onViewOpenChange, onViewCovered } = useProjectRoute();
  const navigation = useNavigation<ProjectStackNavigation>();
  const isFocused = useIsFocused();
  // Set once the route is leaving, so the pop below never runs a second time.
  const removingRef = React.useRef(false);

  // The store is back on project home while this route animates out. Keep the
  // last content on screen until the route unmounts.
  const lastViewRef = React.useRef<React.ReactNode>(view);
  if (view) lastViewRef.current = view;

  const callbacksRef = React.useRef({ goHome, onViewOpenChange, onViewCovered });
  callbacksRef.current = { goHome, onViewOpenChange, onViewCovered };

  React.useEffect(() => {
    callbacksRef.current.onViewOpenChange(true);
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
      callbacksRef.current.onViewOpenChange(false);
    };
  }, [navigation]);

  React.useEffect(() => {
    if (!isHome || !isFocused || removingRef.current) return;
    removingRef.current = true;
    navigation.goBack();
  }, [isHome, isFocused, navigation]);

  return <PageBackProvider value={goHome}>{lastViewRef.current}</PageBackProvider>;
}
