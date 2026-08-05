import assert from "node:assert/strict";
import test from "node:test";
import { readWorkbenchRoute, workbenchRouteHref } from "../web/src/urlState.ts";

function location(href: string): Pick<Location, "href" | "search"> {
  const url = new URL(href);
  return { href: url.href, search: url.search };
}

test("session view and timeline anchor round-trip through the URL", () => {
  const route = {
    sessionId: "session/a & b",
    view: "agent" as const,
    position: { _tag: "timeline" as const, anchor: "message-42/a", sequence: 42, offset: -17 },
  };
  const href = workbenchRouteHref(route, "https://piss.test/?theme=dark#composer");

  assert.equal(href, "/?theme=dark&session=session%2Fa+%26+b&view=agent&at=message-42%2Fa&sequence=42&offset=-17#composer");
  assert.deepEqual(readWorkbenchRoute(location(`https://piss.test${href}`)), route);
});

test("non-agent pages retain their nested scroll position", () => {
  const href = workbenchRouteHref({
    sessionId: "session-1",
    view: "changes",
    position: { _tag: "scroll", top: 418.7 },
  }, "https://piss.test/?at=stale&sequence=1&offset=2");

  assert.equal(href, "/?session=session-1&view=changes&scroll=419");
  assert.deepEqual(readWorkbenchRoute(location(`https://piss.test${href}`)), {
    sessionId: "session-1",
    view: "changes",
    position: { _tag: "scroll", top: 419 },
  });
});

test("workflow panes retain their nested scroll position", () => {
  const href = workbenchRouteHref({
    sessionId: "session-1",
    view: "workflow",
    position: { _tag: "scroll", top: 275 },
  }, "https://piss.test/");

  assert.equal(href, "/?session=session-1&view=workflow&scroll=275");
  assert.deepEqual(readWorkbenchRoute(location(`https://piss.test${href}`)), {
    sessionId: "session-1",
    view: "workflow",
    position: { _tag: "scroll", top: 275 },
  });
});

test("missing and malformed route values safely open the agent at latest", () => {
  assert.deepEqual(readWorkbenchRoute(location("https://piss.test/?view=changes&scroll=100")), {
    view: "agent",
    position: { _tag: "latest" },
  });
  assert.deepEqual(readWorkbenchRoute(location("https://piss.test/?session=s1&view=nope&at=row&sequence=nan")), {
    sessionId: "s1",
    view: "agent",
    position: { _tag: "latest" },
  });
});
