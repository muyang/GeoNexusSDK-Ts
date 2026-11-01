/**
 * GeoMCP client — JSON-RPC 2.0 over HTTP.
 *
 * The envelope semantics are contract, not implementation detail, so this client
 * checks them explicitly rather than trusting the peer:
 *   - `jsonrpc` must be exactly `"2.0"`
 *   - the response `id` must echo the request `id`
 *   - a response must carry exactly one of `result` / `error`
 *
 * Same checks as the Python `GeoMCPClient`; they are what the shared
 * conformance vectors (``contracts/conformance/vectors.json``) pin down.
 */

import { GeoMcpError } from "./errors.js";

/** Methods every GeoMCP implementation must answer. */
export const GEOMCP_METHODS = [
  "geo.capabilities",
  "geo.describe",
  "geo.execute",
  "geo.invoke",
  "geo.plan",
  "geo.health",
] as const;

export type GeoMcpMethod = (typeof GEOMCP_METHODS)[number];

/** Methods that consume resources or change state (need an API key). */
export const WRITE_METHODS: ReadonlySet<string> = new Set(["geo.execute", "geo.invoke"]);

export interface SpatialContext {
  bbox: number[];
  crs: string;
}

export interface TemporalContext {
  start?: string;
  end?: string;
}

export interface ExecuteParams {
  skill: string;
  geocards?: string[];
  spatial?: SpatialContext;
  temporal?: TemporalContext;
  params?: Record<string, unknown>;
}

export interface DescribeParams {
  geocards?: string[];
  skills?: string[];
  recipes?: string[];
}

export interface PlanParams {
  recipe: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  id: string;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorBody | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GeoMcpClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchFn?: FetchLike;
}

let requestCounter = 0;

/** Monotonic-ish request id; unique enough for a single process. */
export function makeRequestId(): string {
  requestCounter += 1;
  return `ts-${Date.now().toString(36)}-${requestCounter}`;
}

export function buildRequest(
  method: string,
  params: Record<string, unknown>,
  id: string,
): JsonRpcRequest {
  return { jsonrpc: "2.0", method, params, id };
}

/** A GeoMCP transport or protocol failure (as opposed to an application error). */
export class GeoMcpClientError extends GeoMcpError {
  constructor(message: string, code = -32603, data?: unknown) {
    super(code, message, data);
    this.name = "GeoMcpClientError";
  }
}

export class GeoMcpClient {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(options: GeoMcpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** `geo.capabilities` — what this node can do. */
  async capabilities(): Promise<Record<string, unknown>> {
    return this.call("geo.capabilities", {});
  }

  /** `geo.health` — liveness and self-checks. */
  async health(): Promise<Record<string, unknown>> {
    return this.call("geo.health", {});
  }

  /** `geo.describe` — contracts of specific cards/skills/recipes. */
  async describe(params: DescribeParams): Promise<Record<string, unknown>> {
    return this.call("geo.describe", params as Record<string, unknown>);
  }

  /** `geo.execute` — run a skill. */
  async execute(params: ExecuteParams): Promise<Record<string, unknown>> {
    return this.call("geo.execute", params as unknown as Record<string, unknown>);
  }

  /** `geo.plan` — materialise a recipe + params into a task graph. */
  async plan(params: PlanParams): Promise<Record<string, unknown>> {
    return this.call("geo.plan", params as unknown as Record<string, unknown>);
  }

  /**
   * POST one JSON-RPC request and enforce the envelope contract.
   *
   * Throws {@link GeoMcpClientError} for transport/protocol problems and
   * {@link GeoMcpError} when the server returned a well-formed `error` object —
   * the distinction matters: only the latter carries a meaningful code the
   * caller can branch on (e.g. 2001 `skill-not-found`).
   */
  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = makeRequestId();
    const payload = buildRequest(method, params, id);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/geomcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";
      throw new GeoMcpClientError(
        aborted
          ? `GeoMCP request timed out after ${this.timeoutMs}ms (method=${method})`
          : `GeoMCP transport error (method=${method}): ${String(cause)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new GeoMcpClientError(
        `GeoMCP response is not JSON (status=${response.status})`,
      );
    }

    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new GeoMcpClientError(`Invalid JSON-RPC response envelope (status=${response.status})`);
    }
    const envelope = data as JsonRpcResponse;

    if (envelope.jsonrpc !== "2.0") {
      throw new GeoMcpClientError(`Invalid JSON-RPC response envelope (status=${response.status})`);
    }
    if (envelope.id !== id) {
      throw new GeoMcpClientError(
        `JSON-RPC id mismatch: expected ${JSON.stringify(id)}, got ${JSON.stringify(envelope.id)}`,
      );
    }
    if (envelope.error !== undefined && envelope.error !== null) {
      const err = envelope.error;
      throw new GeoMcpError(
        typeof err.code === "number" ? err.code : -32603,
        typeof err.message === "string" ? err.message : "GeoMCP error",
        err.data,
      );
    }
    if (!("result" in envelope)) {
      throw new GeoMcpClientError("JSON-RPC response has neither result nor error");
    }
    const result = envelope.result;
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new GeoMcpClientError(
        `GeoMCP result must be an object, got ${Array.isArray(result) ? "array" : typeof result}`,
      );
    }
    return result as Record<string, unknown>;
  }
}

/** Convenience: list skill names a node advertises. */
export function advertisedSkills(capabilities: Record<string, unknown>): string[] {
  const skills = capabilities["skills"];
  if (!Array.isArray(skills)) return [];
  const names: string[] = [];
  for (const entry of skills) {
    if (typeof entry === "string") names.push(entry);
    else if (entry !== null && typeof entry === "object" && "name" in entry) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}
