import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AppConfigLive } from "./config.ts";
import { FileMentionSearchLive } from "./files/FileMentionSearch.ts";
import { runHttpServer } from "./http.ts";
import { PiRuntimeSupervisorLive } from "./runtimes/PiRuntimeSupervisor.ts";
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

const program = Effect.scoped(runHttpServer).pipe(
  Effect.provide(ApplicationLive),
  Effect.tapCause((cause) => Console.error(cause)),
);

const abortController = new AbortController();
const stop = () => abortController.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

void Effect.runPromise(program, { signal: abortController.signal }).catch(() => {
  if (!abortController.signal.aborted) process.exitCode = 1;
});
