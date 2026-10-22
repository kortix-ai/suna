import {
  PROJECT_HOME_ROUTE,
  PROJECT_PAGE_ROUTE,
  PROJECT_VIEW_ROUTE,
  backFromSubPage,
} from '@/components/session/ProjectRoutes';
import {
  type ProjectDrawerRoute,
  type SubPageId,
  androidBackMove,
  drawerRouteMove,
  homeAndRoute,
  returnHomeMove,
  subPageOpenMove,
} from '@/lib/session/project-stack';
import { useRouter } from 'expo-router';
import {
  CommonActions,
  type NavigationProp,
  type ParamListBase,
  StackActions,
  useFocusEffect,
  useNavigation,
} from 'expo-router/react-navigation';
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';

/**
 * The project screen's navigation-stack glue, lifted out of ProjectScreen: the
 * top (focused) route of the project stack and its navigation object, the edge
 * gesture the left edge performs, and every dispatch that moves the stack
 * (replace the project, return home, navigate a drawer route, open a
 * sub-page). Registers the Android back handler. The stack's focus listener
 * stays on ProjectScreen's <Stack> and writes the returned refs and
 * `setEdgeGesture` (`projectEdgeGesture`).
 */
export function useProjectStack(
  projectId: string,
  goHome: () => void,
  returnToThread: () => boolean,
  drawerOpen: boolean,
  setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>,
) {
  // The top (focused) route of the project stack and its navigation object,
  // captured from the stack's focus events (screenListeners below). This
  // layout's own `useNavigation()` is the root stack and cannot see the
  // project stack; the listener's `navigation` is the project stack screen's
  // (useNavigationBuilder: `descriptors[route.key].navigation`). Refs, not
  // state: nothing renders from them, the drawer and back handler read them
  // when they run. Null until the stack's first focus event (home).
  const topRouteRef = useRef<string | null>(null);
  const topNavigationRef = useRef<NavigationProp<ParamListBase> | null>(null);
  // What the left edge does on the focused route (projectEdgeGesture): the
  // drawer, or back on a sub-page (iOS swipe-back). State, not a ref: the
  // drawer's swipeEnabled renders from it.
  const [edgeGesture, setEdgeGesture] = useState<'drawer' | 'back'>('drawer');
  // This layout's own screen in the root stack (/projects/[id]).
  const navigation = useNavigation();
  const router = useRouter();

  // The switcher's pick of another project: replace this whole project in the
  // root stack, so ProjectScreen remounts on the new `id`.
  // `router.replace(projectHref(id))` cannot do it from here: expo-router
  // treats `projects/[id]` → `projects/[id]` as the same route whatever the
  // `id`, and dispatches into the project stack (ProjectSwitcherSheet,
  // `openProjectRoute`).
  const replaceProject = useCallback(
    (nextProjectId: string) => {
      navigation.dispatch(StackActions.replace('projects/[id]', { id: nextProjectId }));
    },
    [navigation],
  );

  // Back to project home from any project route: reset the store, then pop a
  // covering route. popTo keeps home's params and, when home is not in the
  // stack (a deep link straight to a covering route), replaces the top with it.
  // The view's `beforeRemove` also resets the store; running goHome twice is
  // harmless.
  const returnHome = useCallback(() => {
    goHome();
    const top = topNavigationRef.current;
    if (!top || returnHomeMove(topRouteRef.current) === 'none') return;
    top.dispatch(StackActions.popTo(PROJECT_HOME_ROUTE, undefined, { merge: true }));
  }, [goHome]);

  // The drawer's Sessions, Files, and avatar (Account): push over home,
  // replace the covering route, pop back to it under sub-pages, or reset to
  // [home, route], so the drawer never deepens the stack
  // (lib/session/project-stack). Leaving the view resets the store first, so
  // the new route never mounts while the store still shows a session (a
  // covering route replaces itself with the view when the store is off home).
  // A session row needs no stack move here: home pushes the view, an open
  // view swaps its content, and a covering route replaces itself with the view
  // (useCoveringRoute).
  const navigateProjectRoute = useCallback(
    (route: ProjectDrawerRoute, routeParams?: Record<string, string>) => {
      const top = topNavigationRef.current;
      const stack = top ? top.getState().routes : null;
      const move = drawerRouteMove(stack?.map((r) => r.name) ?? null, route);
      if (move === 'none') return;
      const params = { id: projectId, ...routeParams };
      if (!top || !stack) {
        // No focus event yet: the stack is on project home. `route` is the
        // ProjectDrawerRoute union, so this template literal matches one of
        // the typed router's declared `/projects/[id]/<route>` pathnames.
        router.push({ pathname: `/projects/[id]/${route}`, params });
        return;
      }
      if (move === 'push') {
        top.dispatch(StackActions.push(route, params));
        return;
      }
      if (move === 'pop-to') {
        top.dispatch(StackActions.popTo(route, params, { merge: true }));
        return;
      }
      // replace and reset remove the view when it is in the stack.
      if (stack.some((r) => r.name === PROJECT_VIEW_ROUTE)) goHome();
      if (move === 'replace') {
        top.dispatch(StackActions.replace(route, params));
        return;
      }
      // reset: keep project home mounted (its route object keeps its key).
      top.dispatch(CommonActions.reset(homeAndRoute(stack[0], { name: route, params })));
    },
    [goHome, router, projectId],
  );

  // Push a sub-page over the focused route: project Settings from Settings,
  // Schedules or Secrets from project Settings. Back pops exactly this one.
  // Reads the live stack, not topRouteRef: a double tap lands before the
  // first push's focus event.
  const openSubPage = useCallback(
    (pageId: SubPageId) => {
      const top = topNavigationRef.current;
      if (!top) return;
      const state = top.getState();
      const last = state.routes[state.routes.length - 1];
      const lastPageId = (last?.params as { pageId?: string } | undefined)?.pageId ?? null;
      const move = subPageOpenMove(last ? { name: last.name, pageId: lastPageId } : null, pageId);
      if (move === 'none') return;
      top.dispatch(StackActions.push(PROJECT_PAGE_ROUTE, { id: projectId, pageId }));
    },
    [projectId],
  );

  // Back never leaves the project. iOS: the root stack registers
  // /projects/[id] with swipe-back off (app/_layout.tsx), and the project
  // stack has swipe-back off too: the left edge opens the drawer on every
  // project route. Android back: closes the drawer; on a covering route (the
  // view, Sessions, Files, or Account) returns to project home; on project
  // home it is never allowed to pop to a screen below, and with nothing below
  // the system handles it (app to background).
  // Only the drawer's switcher row (a picked project) leaves this project;
  // the project stack itself never pops below it.
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return undefined;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        switch (androidBackMove(topRouteRef.current, drawerOpenRef.current)) {
          case 'close-drawer':
            setDrawerOpen(false);
            return true;
          case 'pop':
            // A sub-page: back to the screen it was opened from.
            if (topNavigationRef.current) backFromSubPage(topNavigationRef.current);
            return true;
          case 'pop-home':
            // A page opened over a thread returns to that thread, not to home.
            if (!returnToThread()) returnHome();
            return true;
          case 'home':
            // `navigation` is the root stack: never pop below the project.
            return navigation.canGoBack();
        }
      });
      return () => subscription.remove();
    }, [navigation, returnHome, returnToThread]),
  );
  return {
    topRouteRef,
    topNavigationRef,
    edgeGesture,
    setEdgeGesture,
    replaceProject,
    returnHome,
    navigateProjectRoute,
    openSubPage,
  };
}
