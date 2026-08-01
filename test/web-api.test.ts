import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import { ApiError, loadWorkspaces, sendSessionCommand } from "../web/src/api.ts";

function withFetch(respond: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = respond as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("safe API reads recover from transient non-JSON gateway responses", async () => {
  let calls = 0;
  const restore = withFetch(async () => {
    calls += 1;
    if (calls < 3) return new Response("upstream unavailable", { status: 503, headers: { "Content-Type": "text/plain" } });
    return Response.json({ workspaces: [] });
  });
  try {
    assert.deepEqual(await Effect.runPromise(loadWorkspaces), { workspaces: [] });
    assert.equal(calls, 3);
  } finally {
    restore();
  }
});

test("non-JSON API errors identify the request and response type", async () => {
  const restore = withFetch(async () => new Response("<html>sign in</html>", {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
  try {
    await assert.rejects(
      Effect.runPromise(loadWorkspaces),
      (cause: unknown) => cause instanceof ApiError
        && cause.status === 401
        && cause.message === "Expected JSON from GET /api/workspaces, but received text/html (401)",
    );
  } finally {
    restore();
  }
});

test("idempotent command submissions retry a transient gateway response", async () => {
  let calls = 0;
  const restore = withFetch(async () => {
    calls += 1;
    if (calls === 1) return new Response("bad gateway", { status: 502, headers: { "Content-Type": "text/plain" } });
    return Response.json({ accepted: true }, { status: 202 });
  });
  try {
    await Effect.runPromise(sendSessionCommand({
      sessionId: "session-1",
      runtimeId: "runtime-1",
      commandId: "command-1",
      action: "prompt",
      text: "hello",
    }));
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});
