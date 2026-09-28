const API_URL = (process.env.RUSTBOX_API_URL ?? "https://api.rustbox.sh").replace(/\/$/, "");
const ALLOWED = new Set(["javascript", "python"]);
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 256 * 1024;

export type RunRequest = { language: "javascript" | "python"; code: string; stdin?: string };
export type RunResult = {
  id?: string;
  status: string;
  verdict: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  wallTimeSeconds?: number;
};

function cappedOutput(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return Buffer.byteLength(text, "utf8") > 64 * 1024
    ? Buffer.from(text, "utf8").subarray(0, 64 * 1024).toString("utf8")
    : text;
}

export class RunnerError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

export async function runCode(input: RunRequest): Promise<RunResult> {
  const apiKey = process.env.RUSTBOX_API_KEY;
  if (!apiKey) throw new RunnerError("Code execution is not configured", 503, "RUNNER_UNAVAILABLE");
  if (!ALLOWED.has(input.language)) throw new RunnerError("Language is not supported", 400, "UNSUPPORTED_LANGUAGE");
  if (!input.code.trim()) throw new RunnerError("Code cannot be empty", 400, "EMPTY_CODE");
  if (Buffer.byteLength(input.code, "utf8") > MAX_SOURCE_BYTES) throw new RunnerError("Source exceeds 64 KB", 413, "SOURCE_TOO_LARGE");
  if (Buffer.byteLength(input.stdin ?? "", "utf8") > MAX_STDIN_BYTES) throw new RunnerError("stdin exceeds 256 KB", 413, "STDIN_TOO_LARGE");

  let response: globalThis.Response;
  try {
    response = await fetch(`${API_URL}/api/submit?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ language: input.language, code: input.code, stdin: input.stdin ?? "" }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new RunnerError("Execution timed out while waiting for Rustbox", 504, "RUNNER_TIMEOUT");
    throw new RunnerError("Could not reach the execution service", 502, "RUNNER_NETWORK_ERROR");
  }

  const body = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) {
    if (response.status === 429) throw new RunnerError("Rustbox rate limit reached. Try again shortly.", 429, "RUNNER_RATE_LIMIT");
    if (response.status === 503) throw new RunnerError("Execution queue is full. Try again shortly.", 503, "RUNNER_QUEUE_FULL");
    if (response.status === 408) throw new RunnerError("Execution exceeded the Rustbox time limit", 408, "RUNNER_TIMEOUT");
    if (response.status === 401) throw new RunnerError("Execution provider credentials are invalid", 502, "RUNNER_AUTH_ERROR");
    throw new RunnerError(typeof body.error === "string" ? body.error : "Execution request failed", 502, "RUNNER_ERROR");
  }

  const verdict = body.result?.verdict ?? (body.status === "completed" ? "AC" : body.status ?? "UNKNOWN");
  return {
    id: body.id,
    status: body.status ?? "completed",
    verdict,
    stdout: cappedOutput(body.output?.stdout),
    stderr: cappedOutput(body.output?.stderr),
    exitCode: body.result?.exit_code ?? null,
    error: body.result?.error_message ?? (verdict === "AC" ? null : `${verdict}: ${body.result?.cause ?? "Execution did not complete successfully"}`),
    wallTimeSeconds: body.metrics?.wall_time_secs,
  };
}
