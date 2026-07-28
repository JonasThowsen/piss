import * as Data from "effect/Data";

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly message: string;
}> {}

export class HttpServerError extends Data.TaggedError("HttpServerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class StaticAssetError extends Data.TaggedError("StaticAssetError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class HttpRequestError extends Data.TaggedError("HttpRequestError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}
