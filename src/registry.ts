/**
 * GeoCard Registry client — discovery, registration and review.
 *
 * The registry is how a node becomes *findable*. Two rules from the Python SDK
 * carry over verbatim because they trip people up:
 *
 *   1. Registration is not publication. On a registry opened for public
 *      submissions every write lands as `pending` and stays invisible to
 *      `search()` until a *different* principal approves it.
 *   2. A card is only findable by capability if it actually declares
 *      `capabilities`. Tags do not count.
 */

import type { GeoCard } from "./geocard.js";
import { RegistryError } from "./errors.js";

export interface RegistryClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchFn?: FetchLike;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RegisterOptions {
  /** Omit for the registry default; pass `"pending"` to submit for review. */
  status?: "pending" | "approved";
  reviewNote?: string;
  submittedBy?: string;
}

export interface SearchQuery {
  capability?: string;
  type?: string;
  bbox?: number[];
  crs?: string;
  start?: string;
  end?: string;
  requiredBands?: string[];
  requiredResolution?: number;
  status?: string;
}

export interface SearchResult {
  entry: RegistryEntry;
  contract?: unknown;
}

export interface RegistryEntry {
  card: GeoCard;
  node_url: string;
  registered_at?: string;
  status?: string;
  review_note?: string | null;
  [key: string]: unknown;
}

export class RegistryClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(options: RegistryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Register (or re-register) a card owned by `nodeUrl`. */
  async register(
    card: GeoCard,
    nodeUrl: string,
    options: RegisterOptions = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { card, node_url: nodeUrl };
    if (options.status !== undefined) body["status"] = options.status;
    if (options.reviewNote !== undefined) body["review_note"] = options.reviewNote;
    if (options.submittedBy !== undefined) body["submitted_by"] = options.submittedBy;
    return this.call("POST", "/cards", body);
  }

  async unregister(cardId: string): Promise<Record<string, unknown>> {
    return this.call("DELETE", `/cards/${encodeURIComponent(cardId)}`);
  }

  async get(cardId: string): Promise<RegistryEntry> {
    const data = await this.call("GET", `/cards/${encodeURIComponent(cardId)}`);
    return unwrapEntry(data);
  }

  async listCards(status?: string): Promise<RegistryEntry[]> {
    const query = status === undefined ? {} : { status };
    const data = await this.call("GET", "/cards", undefined, query);
    const cards = data["cards"] ?? data["entries"] ?? [];
    return Array.isArray(cards) ? cards.map((c) => unwrapEntry(c as Record<string, unknown>)) : [];
  }

  /** Approve a pending submission. Needs the reviewer's key. */
  async approve(cardId: string, note = "", by = ""): Promise<Record<string, unknown>> {
    return this.call("POST", `/cards/${encodeURIComponent(cardId)}/approve`, { note, by });
  }

  async reject(cardId: string, note = "", by = ""): Promise<Record<string, unknown>> {
    return this.call("POST", `/cards/${encodeURIComponent(cardId)}/reject`, { note, by });
  }

  /** Nodes known to this registry. */
  async getNodes(): Promise<Record<string, unknown>> {
    return this.call("GET", "/nodes");
  }

  /** Contract-aware search. Returns `[{entry, contract}]`. */
  async search(query: SearchQuery = {}): Promise<SearchResult[]> {
    const params: Record<string, string> = {};
    if (query.capability !== undefined) params["capability"] = query.capability;
    if (query.type !== undefined) params["type"] = query.type;
    if (query.bbox !== undefined) params["bbox"] = query.bbox.join(",");
    if (query.crs !== undefined) params["crs"] = query.crs;
    if (query.start !== undefined) params["start"] = query.start;
    if (query.end !== undefined) params["end"] = query.end;
    if (query.requiredBands !== undefined) params["required_bands"] = query.requiredBands.join(",");
    if (query.requiredResolution !== undefined) {
      params["resolution"] = String(query.requiredResolution);
    }
    if (query.status !== undefined) params["status"] = query.status;

    const data = await this.call("GET", "/search", undefined, params);
    const results = data["results"];
    return Array.isArray(results) ? (results as SearchResult[]) : [];
  }

  async health(): Promise<Record<string, unknown>> {
    return this.call("GET", "/health");
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      response = await this.fetchFn(url.toString(), init);
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";
      throw new RegistryError(
        aborted
          ? `Registry request timed out after ${this.timeoutMs}ms (${method} ${path})`
          : `Registry transport error (${method} ${path}): ${String(cause)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new RegistryError(
            `Registry error ${response.status} (${method} ${path}): ${text.slice(0, 300)}`,
            response.status,
            text,
          );
        }
        throw new RegistryError(
          `Registry returned non-JSON (${method} ${path}, status ${response.status})`,
          response.status,
          text,
        );
      }
    }

    if (!response.ok) {
      throw new RegistryError(
        `Registry error ${response.status}: ${text.slice(0, 300)}`,
        response.status,
        data,
      );
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new RegistryError(
        `Registry response must be an object (${method} ${path})`,
        response.status,
        data,
      );
    }
    return data as Record<string, unknown>;
  }
}

/** Accept both a bare card object and `{card: ...}` wrappers. */
function unwrapEntry(value: Record<string, unknown>): RegistryEntry {
  if ("card" in value) return value as unknown as RegistryEntry;
  return { card: value as unknown as GeoCard, node_url: "" };
}
