import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorkspaceReview, WorkspaceReviewLive } from "../server/reviews/WorkspaceReview.ts";
import { WorkspaceDirectory } from "../server/workspaces/WorkspaceDirectory.ts";

const execFileAsync = promisify(execFile);

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function reviewLayer(authorizedRoot: string) {
  const directories = WorkspaceDirectory.of({
    search: () => Effect.succeed([]),
    prepare: (path) => Effect.succeed(path),
    authorize: (path) => Effect.tryPromise(async () => {
      const canonical = await realpath(path);
      if (!isWithin(authorizedRoot, canonical)) throw new Error("outside authorized root");
      return canonical;
    }) as never,
    openAuthorized: (path) => Effect.tryPromise(async () => {
      const canonical = await realpath(path);
      if (!isWithin(authorizedRoot, canonical)) throw new Error("outside authorized root");
      return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    }) as never,
    rollbackCreated: () => Effect.void,
  });
  return WorkspaceReviewLive.pipe(Layer.provide(Layer.succeed(WorkspaceDirectory, directories)));
}

async function collect(root: string, authorizedRoot: string, signal?: AbortSignal) {
  const identity = await stat(root, { bigint: true });
  return Effect.runPromise(
    Effect.gen(function* () {
      const reviews = yield* WorkspaceReview;
      return yield* reviews.collect(root, { device: identity.dev, inode: identity.ino });
    }).pipe(Effect.provide(reviewLayer(authorizedRoot))),
    signal ? { signal } : undefined,
  );
}

async function expectReviewFailure(root: string, authorizedRoot: string, pattern: RegExp) {
  await assert.rejects(collect(root, authorizedRoot), (cause: unknown) => {
    assert.match(cause instanceof Error ? cause.message : String(cause), pattern);
    return true;
  });
}

test("reviews registered Git worktrees with absolute and relative gitdir pointers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piss-worktree-review-"));
  const repository = join(directory, "repository");
  const worktree = join(directory, "worktrees", "dev-1");
  try {
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "piss@example.test"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "PISS test"], { cwd: repository });
    await mkdir(join(repository, "packages", "app"), { recursive: true });
    await writeFile(join(repository, "tracked.ts"), "export const value = 1;\n");
    await writeFile(join(repository, "packages", "app", "nested.ts"), "export const nested = 1;\n");
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: repository });
    await mkdir(resolve(worktree, ".."), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-qb", "dev-1", worktree], { cwd: repository });

    await writeFile(join(worktree, "tracked.ts"), "export const value = 2;\n");
    await execFileAsync("git", ["add", "tracked.ts"], { cwd: worktree });
    await writeFile(join(worktree, "tracked.ts"), "export const value = 3;\n");
    await writeFile(join(worktree, "untracked.md"), "# Worktree\n");
    await writeFile(join(worktree, "packages", "app", "nested.ts"), "export const nested = 2;\n");

    const absolute = await collect(worktree, directory);
    assert.deepEqual(absolute.files.map((file) => file.path).sort(), ["packages/app/nested.ts", "tracked.ts", "untracked.md"]);
    assert.match(absolute.files.find((file) => file.path === "tracked.ts")?.patch ?? "", /# STAGED/);
    assert.match(absolute.files.find((file) => file.path === "tracked.ts")?.patch ?? "", /# UNSTAGED/);
    const nested = await collect(join(worktree, "packages", "app"), directory);
    assert.deepEqual(nested.files.map((file) => file.path), ["nested.ts"]);

    const gitFile = join(worktree, ".git");
    const absolutePointer = await readFile(gitFile, "utf8");
    const gitDirectory = absolutePointer.trim().slice("gitdir: ".length);
    await writeFile(gitFile, `gitdir: ${relative(worktree, gitDirectory)}\n`);
    const relativePointer = await collect(worktree, directory);
    assert.equal(relativePointer.totalFiles, 3);

    await writeFile(gitFile, "not a git pointer\n");
    await expectReviewFailure(worktree, directory, /malformed/i);

    await writeFile(gitFile, "gitdir: ../../../../etc\n");
    await expectReviewFailure(worktree, directory, /outside authorized roots|malformed|collect/i);

    const unrelated = join(directory, "unrelated");
    await mkdir(unrelated);
    await execFileAsync("git", ["init", "-q"], { cwd: unrelated });
    await writeFile(gitFile, `gitdir: ${join(unrelated, ".git")}\n`);
    await expectReviewFailure(worktree, directory, /collect|pointer|registered|Git/i);

    await writeFile(gitFile, absolutePointer);
    await rename(gitFile, `${gitFile}.valid`);
    await symlink(`${gitFile}.valid`, gitFile);
    await expectReviewFailure(worktree, directory, /malformed|symlink/i);
    await rm(gitFile);
    await rename(`${gitFile}.valid`, gitFile);

    const index = join(gitDirectory, "index");
    await rename(index, `${index}.valid`);
    await symlink(`${index}.valid`, index);
    await expectReviewFailure(worktree, directory, /collect|symlink/i);
    await rm(index);
    await rename(`${index}.valid`, index);

    const controller = new AbortController();
    controller.abort(new Error("review cancelled"));
    await assert.rejects(collect(worktree, directory, controller.signal), /review cancelled|Interrupted|abort/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
