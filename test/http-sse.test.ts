import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSessionEventStreamWriter } from "../server/http.ts";
import type { OwnedSession, OwnedSessionEvent } from "../shared/domain.ts";

class BackpressuredResponse extends EventEmitter {
  readonly chunks: string[] = [];
  readonly results: boolean[];
  writableEnded = false;
  destroyed = false;

  constructor(results: boolean[]) {
    super();
    this.results = [...results];
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.results.shift() ?? true;
  }
}

function session(...sequences: number[]): OwnedSession {
  const events: OwnedSessionEvent[] = sequences.map((sequence) => ({
    sequence,
    type: "message_end",
    timestamp: new Date(sequence * 1_000).toISOString(),
    data: { sequence },
  }));
  return { events, interactiveRequests: [] } as unknown as OwnedSession;
}

function frame(chunk: string): { readonly id: number; readonly reset: boolean; readonly sequences: number[] } {
  const id = Number(/^id: (\d+)$/mu.exec(chunk)?.[1]);
  const data = /^data: (.+)$/mu.exec(chunk)?.[1];
  assert.ok(data, "expected an SSE data field");
  const parsed = JSON.parse(data) as { reset: boolean; session: { events: OwnedSessionEvent[] } };
  return { id, reset: parsed.reset, sequences: parsed.session.events.map((event) => event.sequence) };
}

test("SSE backpressure retains only the latest pending session projection", () => {
  const response = new BackpressuredResponse([false, true, false, true, false]);
  const writer = createSessionEventStreamWriter(response, 0);

  writer.publish(session(1));
  writer.heartbeat();
  writer.publish(session(1, 2));
  writer.publish(session(1, 2, 3));

  assert.equal(response.chunks.length, 1, "blocked streams do not enqueue another frame or heartbeat");
  assert.equal(response.listenerCount("drain"), 1);

  response.emit("drain");
  assert.deepEqual(frame(response.chunks[1]!), { id: 3, reset: false, sequences: [2, 3] });

  writer.publish(session(10));
  writer.publish(session(11));
  writer.publish(session(12));
  assert.equal(response.chunks.length, 3, "only the accepted frame is buffered while backpressured");
  assert.deepEqual(frame(response.chunks[2]!), { id: 10, reset: true, sequences: [10] });

  response.emit("drain");
  assert.equal(response.chunks.length, 4);
  assert.deepEqual(frame(response.chunks[3]!), { id: 12, reset: true, sequences: [12] });

  writer.publish(session(13));
  writer.publish(session(14));
  assert.equal(response.listenerCount("drain"), 1);
  writer.close();
  assert.equal(response.listenerCount("drain"), 0);
  response.emit("drain");
  assert.equal(response.chunks.length, 5, "closing drops the one pending projection");
});
