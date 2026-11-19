/** Structured logs: one JSON object per line, so Workers Logs can filter on any field. */
export function log(event: string, fields: Record<string, unknown> = {}, level: "info" | "error" = "info"): void {
  const line = JSON.stringify({ event, ...fields });
  if (level === "error") console.error(line);
  else console.info(line);
}

/** What is safe and useful to log about a thrown value. */
export function describeError(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) return { error: `${error.name}: ${error.message}`, ...(error.stack ? { stack: error.stack.slice(0, 2000) } : {}) };
  return { error: String(error) };
}
