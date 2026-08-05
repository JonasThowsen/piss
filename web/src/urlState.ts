export const SESSION_VIEWS = ["agent", "workflow", "changes", "details"] as const;

export type SessionView = typeof SESSION_VIEWS[number];

export type PagePosition =
  | { readonly _tag: "latest" }
  | { readonly _tag: "timeline"; readonly anchor: string; readonly sequence: number; readonly offset: number }
  | { readonly _tag: "scroll"; readonly top: number };

export type WorkbenchRoute = {
  readonly sessionId?: string;
  readonly view: SessionView;
  readonly position: PagePosition;
};

type LocationLike = Pick<Location, "href" | "search">;

function finiteInteger(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function readWorkbenchRoute(location: LocationLike = window.location): WorkbenchRoute {
  const parameters = new URLSearchParams(location.search);
  const sessionId = parameters.get("session")?.trim() || undefined;
  const requestedView = parameters.get("view");
  const view: SessionView = SESSION_VIEWS.includes(requestedView as SessionView) ? requestedView as SessionView : "agent";

  if (!sessionId) return { view: "agent", position: { _tag: "latest" } };
  if (view !== "agent") {
    const top = finiteInteger(parameters.get("scroll"));
    return { sessionId, view, position: { _tag: "scroll", top: top !== undefined && top > 0 ? top : 0 } };
  }

  const anchor = parameters.get("at");
  const sequence = finiteInteger(parameters.get("sequence"));
  const offset = finiteInteger(parameters.get("offset"));
  if (anchor && anchor !== "latest" && sequence !== undefined && sequence >= 0) {
    return { sessionId, view, position: { _tag: "timeline", anchor, sequence, offset: offset ?? 0 } };
  }
  return { sessionId, view, position: { _tag: "latest" } };
}

export function workbenchRouteHref(route: WorkbenchRoute, currentHref: string): string {
  const url = new URL(currentHref);
  for (const name of ["session", "view", "at", "sequence", "offset", "scroll"]) url.searchParams.delete(name);

  if (route.sessionId) {
    url.searchParams.set("session", route.sessionId);
    url.searchParams.set("view", route.view);
    if (route.view === "agent") {
      if (route.position._tag === "timeline") {
        url.searchParams.set("at", route.position.anchor);
        url.searchParams.set("sequence", String(route.position.sequence));
        if (route.position.offset !== 0) url.searchParams.set("offset", String(Math.round(route.position.offset)));
      } else {
        url.searchParams.set("at", "latest");
      }
    } else {
      const top = route.position._tag === "scroll" ? Math.max(0, Math.round(route.position.top)) : 0;
      if (top > 0) url.searchParams.set("scroll", String(top));
    }
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function writeWorkbenchRoute(route: WorkbenchRoute, mode: "push" | "replace"): void {
  const href = workbenchRouteHref(route, window.location.href);
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === href) return;
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", href);
}

export function defaultPagePosition(view: SessionView): PagePosition {
  return view === "agent" ? { _tag: "latest" } : { _tag: "scroll", top: 0 };
}
