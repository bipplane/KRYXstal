export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    /** Extra fields merged into the JSON error body (e.g. a structured `conflict`). */
    public readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}
