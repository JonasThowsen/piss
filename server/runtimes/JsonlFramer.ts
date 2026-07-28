import { StringDecoder } from "node:string_decoder";

export class JsonlFrameTooLargeError extends Error {
  readonly _tag = "JsonlFrameTooLargeError";

  constructor(readonly maximumBytes: number) {
    super(`RPC frame exceeded ${maximumBytes} bytes`);
  }
}

export class JsonlFramer {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #bufferBytes = 0;
  #discardingAggregate?: string;

  constructor(
    readonly maximumBytes = 64 * 1024 * 1024,
    readonly aggregateMaximumBytes = 2 * 1024 * 1024,
  ) {}

  push(chunk: Buffer | Uint8Array): ReadonlyArray<string> {
    return this.#consume(this.#decoder.write(Buffer.from(chunk)));
  }

  end(): ReadonlyArray<string> {
    const lines = [...this.#consume(this.#decoder.end())];
    if (this.#discardingAggregate) {
      lines.push(this.#aggregatePlaceholder(this.#discardingAggregate));
      this.#discardingAggregate = undefined;
      return lines;
    }
    if (this.#buffer.length === 0) return lines;
    const final = this.#stripCarriageReturn(this.#buffer);
    const aggregate = this.#aggregateType(final);
    if (aggregate && this.#bufferBytes > this.aggregateMaximumBytes) lines.push(this.#aggregatePlaceholder(aggregate));
    else {
      this.#assertBounded(this.#bufferBytes);
      lines.push(final);
    }
    this.#buffer = "";
    this.#bufferBytes = 0;
    return lines;
  }

  #consume(decoded: string): ReadonlyArray<string> {
    const lines: string[] = [];
    if (this.#discardingAggregate) {
      const newline = decoded.indexOf("\n");
      if (newline === -1) return lines;
      lines.push(this.#aggregatePlaceholder(this.#discardingAggregate));
      this.#discardingAggregate = undefined;
      decoded = decoded.slice(newline + 1);
    }

    this.#buffer += decoded;
    this.#bufferBytes += Buffer.byteLength(decoded, "utf8");
    lines.push(...this.#drainCompleteLines());

    const aggregate = this.#aggregateType(this.#buffer);
    if (aggregate && this.#bufferBytes > this.aggregateMaximumBytes) {
      this.#buffer = "";
      this.#bufferBytes = 0;
      this.#discardingAggregate = aggregate;
    } else {
      this.#assertBounded(this.#bufferBytes);
    }
    return lines;
  }

  #drainCompleteLines(): ReadonlyArray<string> {
    const lines: string[] = [];
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) return lines;
      const rawLine = this.#buffer.slice(0, newline);
      const lineBytes = Buffer.byteLength(rawLine, "utf8");
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#bufferBytes -= lineBytes + 1;
      const line = this.#stripCarriageReturn(rawLine);
      const aggregate = this.#aggregateType(line);
      if (aggregate && lineBytes > this.aggregateMaximumBytes) lines.push(this.#aggregatePlaceholder(aggregate));
      else {
        this.#assertBounded(lineBytes);
        lines.push(line);
      }
    }
  }

  #aggregateType(frame: string): string | undefined {
    const match = /^\{"type":"(agent_end|turn_end)"(?:,|\})/.exec(frame.slice(0, 80));
    return match?.[1];
  }

  #aggregatePlaceholder(type: string): string {
    return JSON.stringify({ type, truncated: true, reason: "Aggregate RPC event omitted by PISS" });
  }

  #stripCarriageReturn(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }

  #assertBounded(bytes: number): void {
    if (bytes > this.maximumBytes) {
      this.#buffer = "";
      this.#bufferBytes = 0;
      throw new JsonlFrameTooLargeError(this.maximumBytes);
    }
  }
}
