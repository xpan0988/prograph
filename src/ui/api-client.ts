export class ApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status?: number,
    readonly returnedHtml = false,
    message?: string,
  ) {
    super(message ?? `${operation} failed${status ? ` (${status})` : ""}`);
    this.name = "ApiError";
  }
}

async function requestJson<T>(url: string, operation: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) throw new ApiError(operation, response.status);
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new ApiError(operation, response.status, text.trimStart().startsWith("<"), "The server returned a non-JSON response.");
  }
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError(operation, response.status, false, "The server returned invalid JSON.");
  }
}

export function getJson<T>(url: string, operation: string): Promise<T> {
  return requestJson<T>(url, operation);
}

export function postJson<T>(url: string, operation: string): Promise<T> {
  return requestJson<T>(url, operation, { method: "POST" });
}

export function errorFingerprint(operation: string, error: unknown): string {
  return `${operation}:${error instanceof Error ? error.message : String(error)}`;
}

export function shouldDisplayError(previous: { fingerprint: string; at: number } | undefined, fingerprint: string, now: number, windowMs = 3000): boolean {
  return !previous || previous.fingerprint !== fingerprint || now - previous.at > windowMs;
}
