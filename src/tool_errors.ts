/**
 * Failure reporting for MCP tools.
 *
 * When a tool throws, two different readers need something from it, and
 * they need different things. The agent that made the call needs to know
 * the call failed and roughly why, so it can say so rather than inventing
 * a result. Whoever maintains the server needs the stack, the arguments
 * and the time, later, when they sit down to fix it.
 *
 * A thrown exception serves the first reader badly and the second not at
 * all: the MCP transport reduces it to a message, and once the request is
 * over the context is gone. So failures are captured here instead —
 * turned into a record, handed to a sink, and reported back to the caller
 * as an error result rather than an exception.
 */

/** A tool failure, in the form it is stored and read back in. */
export type ToolFailure = {
  /** When the failure happened, ISO 8601. */
  timestamp: string;
  /** Which tool was called. */
  tool: string;
  /** The authenticated Spotify user, when the request had one. */
  spotifyUserId: string | null;
  /**
   * Arguments the tool was called with, JSON-encoded. Not redacted the way
   * `other-memory`'s equivalent module redacts memory content — no tool
   * here takes free-text personal content as an argument, only queries and
   * ids, so there is nothing in an argument blob that duplicates data the
   * user would not already expect logged.
   */
  arguments: string;
  /** The error message. */
  message: string;
  /** The stack, when the thrown value carried one. */
  stack: string | null;
};

/**
 * Somewhere failures are written.
 *
 * Kept deliberately small so that a deployment can send failures to a
 * database, a log service, or anywhere else, without the library needing
 * to know that such a place exists.
 */
export type FailureSink = (failure: ToolFailure) => void | Promise<void>;

/** Longest argument blob stored, in characters. */
const MAXIMUM_ARGUMENT_LENGTH = 2000;

/**
 * Build a failure record from a thrown value.
 *
 * @param options.tool - Name of the tool that failed.
 * @param options.error - Whatever was thrown. Anything can be thrown in
 *   JavaScript, so non-Error values are described rather than assumed.
 * @param options.args - Arguments the tool was called with.
 * @param options.spotifyUserId - Authenticated caller, when there was one.
 * @param options.timestamp - When the failure happened.
 * @returns The record to store.
 */
export function buildFailure(options: {
  tool: string;
  error: unknown;
  args: unknown;
  spotifyUserId: string | null;
  timestamp: string;
}): ToolFailure {
  const { tool, error, args, spotifyUserId, timestamp } = options;
  const isError = error instanceof Error;
  let encodedArguments: string;
  try {
    encodedArguments = JSON.stringify(args) ?? "null";
  } catch {
    // Arguments arrive from a remote caller and are not guaranteed to be
    // encodable — a cycle here must not mask the failure being reported.
    encodedArguments = '"[unencodable]"';
  }
  return {
    timestamp,
    tool,
    spotifyUserId,
    arguments: encodedArguments.slice(0, MAXIMUM_ARGUMENT_LENGTH),
    message: isError ? error.message : String(error),
    stack: isError ? (error.stack ?? null) : null,
  };
}

/**
 * Write a failure to the console as one structured line.
 *
 * This is the default sink. On Cloudflare it is not a fallback so much as
 * the ordinary path: Workers observability already captures and retains
 * console output, so a deployment that configures nothing still has its
 * failures recorded and searchable.
 *
 * @param failure - The record to write.
 * @returns Nothing.
 */
export const consoleFailureSink: FailureSink = (failure: ToolFailure) => {
  console.error(JSON.stringify({ kind: "tool_failure", ...failure }));
};

/**
 * Whether a failure message is Spotify refusing for rate reasons.
 *
 * Kept here rather than imported from a provider module on purpose: this
 * module is what every tool funnels its errors through, and it must not
 * depend on the module whose calls it is reporting on.
 *
 * @param message - The failure message.
 * @returns True when the message describes a rate limit.
 */
function isRateLimitMessage(message: string): boolean {
  return message.toLowerCase().includes("429");
}

/**
 * Run a tool handler, reporting any failure rather than throwing.
 *
 * @param options.tool - Name of the tool being run.
 * @param options.args - Arguments it was called with.
 * @param options.spotifyUserId - Authenticated caller, when there was one.
 * @param options.sink - Where the failure is written.
 * @param options.run - The handler itself.
 * @returns The handler's result, or an error result describing the
 *   failure.
 */
export async function reportingFailures<Result>(options: {
  tool: string;
  args: unknown;
  spotifyUserId: string | null;
  sink: FailureSink;
  run: () => Promise<Result>;
}): Promise<Result | { content: [{ type: "text"; text: string }]; isError: true }> {
  const { tool, args, spotifyUserId, sink, run } = options;
  try {
    return await run();
  } catch (error) {
    const failure = buildFailure({
      tool,
      error,
      args,
      spotifyUserId,
      timestamp: new Date().toISOString(),
    });
    try {
      await sink(failure);
    } catch (sinkError) {
      // A sink that cannot write must not replace the failure it was
      // asked to record: the original is what the caller needs to hear
      // about, and losing it to a logging problem is the worst outcome.
      console.error(
        JSON.stringify({
          kind: "failure_sink_error",
          tool,
          message: sinkError instanceof Error ? sinkError.message : String(sinkError),
        }),
      );
    }

    const retryAfterMatch = /retryAfterSeconds["\s:]+(\d+)/.exec(failure.message);
    const retryNote = retryAfterMatch
      ? ` Try again in about ${retryAfterMatch[1]} seconds.`
      : "";
    const explanation = isRateLimitMessage(failure.message)
      ? `The ${tool} tool could not run: Spotify's API rate limit is `
        + `exhausted.${retryNote} Nothing is wrong with your library — tell `
        + "the user to try again shortly, and do not treat this as an empty "
        + "or missing result."
      : `The ${tool} tool failed: ${failure.message}\n\n`
        + "This has been logged. Tell the user the call failed rather than "
        + "treating the absence of a result as an answer.";

    return {
      content: [{ type: "text" as const, text: explanation }],
      isError: true,
    };
  }
}
