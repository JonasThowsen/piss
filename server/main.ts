import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AppConfigLive } from "./config.ts";
import { FileMentionSearchLive } from "./files/FileMentionSearch.ts";
import { runHttpServer } from "./http.ts";
import { PiRuntimeSupervisor, PiRuntimeSupervisorLive } from "./runtimes/PiRuntimeSupervisor.ts";
import { PushNotificationsLive } from "./notifications/PushNotifications.ts";
import { WorkspaceReviewLive } from "./reviews/WorkspaceReview.ts";
import { WorkspaceDirectoryLive } from "./workspaces/WorkspaceDirectory.ts";
import { WorkspaceRepositoryLive } from "./workspaces/WorkspaceRepository.ts";

const DirectoryLive = WorkspaceDirectoryLive.pipe(Layer.provideMerge(AppConfigLive));
const WorkspaceLive = WorkspaceRepositoryLive.pipe(Layer.provideMerge(DirectoryLive));
const FileMentionLive = FileMentionSearchLive.pipe(Layer.provideMerge(DirectoryLive));
const NotificationLive = PushNotificationsLive.pipe(Layer.provideMerge(AppConfigLive));
const RuntimeDependenciesLive = Layer.mergeAll(WorkspaceLive, FileMentionLive, NotificationLive);
const RuntimeLive = PiRuntimeSupervisorLive.pipe(Layer.provideMerge(RuntimeDependenciesLive));
const ReviewLive = WorkspaceReviewLive.pipe(Layer.provideMerge(DirectoryLive));
const ApplicationLive = Layer.mergeAll(RuntimeLive, ReviewLive, NotificationLive);

const abortController = new AbortController();
const UPDATE_SHUTDOWN_TIMEOUT_MS = 15_000;
let updateRequested = false;
let beginUpdateActivation = () => {};

const stop = () => abortController.abort();
const requestUpdate = () => {
  updateRequested = true;
  beginUpdateActivation();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.on("SIGUSR2", requestUpdate);

const program = Effect.scoped(Effect.gen(function* () {
  const supervisor = yield* PiRuntimeSupervisor;
  let activating = false;
  beginUpdateActivation = () => {
    if (activating) return;
    activating = true;
    console.log("PISS update staged; waiting for active work to settle before activation");
    void Effect.runPromise(supervisor.awaitUpdateSafe, { signal: abortController.signal }).then(
      () => {
        console.log("PISS sessions are quiescent; activating the staged update");
        const watchdog = setTimeout(() => {
          console.error("PISS update shutdown exceeded its grace period; forcing control-plane exit");
          process.exit(0);
        }, UPDATE_SHUTDOWN_TIMEOUT_MS);
        watchdog.unref();
        stop();
      },
      (cause) => {
        if (!abortController.signal.aborted) console.error("Could not prepare the staged PISS update", cause);
      },
    );
  };
  if (updateRequested) beginUpdateActivation();
  return yield* runHttpServer;
})).pipe(
  Effect.provide(ApplicationLive),
  Effect.tapCause((cause) => Console.error(cause)),
);

void Effect.runPromise(program, { signal: abortController.signal }).catch(() => {
  if (!abortController.signal.aborted) process.exitCode = 1;
});
