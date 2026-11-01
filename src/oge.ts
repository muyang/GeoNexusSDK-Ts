/**
 * OGE (Open Earth Engine) client.
 *
 * Everything here mirrors what was **measured against the live service**, not
 * what a plausible API would look like. Three findings are load-bearing:
 *
 *   1. The business success code is `20000`. `200` and `0` are *failures* on
 *      this service, so accepting them would silently swallow real errors.
 *   2. Authentication failures arrive as business code `40003` (or HTTP
 *      401/403), not always as an HTTP status.
 *   3. Image extents come back as four corner lat/lons, and vector extents as
 *      separate `minLon`/`maxLat` scalars — neither is a `bbox` field.
 *
 * Two token kinds exist and are not interchangeable:
 *   - JWT  (`POST /oauth/token`)            → `Authorization: Bearer <jwt>`
 *   - tk   (`POST /open/app/key/create`)    → `?tk=<tk>` on /openapi/algorithm
 */

import {
  OgeAuthError,
  OgeError,
  OgeExecutionError,
} from "./errors.js";

/** Known OGE sites. These are different deployments with different catalogs. */
export const OGE_SITE_URL = "http://openge.org.cn";
export const OGE_API_BASE = `${OGE_SITE_URL}/api`;
export const OGE_TEST_SITE_URL = "http://47.107.61.86";
export const OGE_TEST_API_BASE = `${OGE_TEST_SITE_URL}/api`;

/** Measured success code. Do not add 0/200 — they are failures here. */
export const OGE_SUCCESS_CODES: ReadonlySet<number> = new Set([20000]);

/** Measured auth-failure business code. */
export const OGE_AUTH_ERROR_CODES: ReadonlySet<number> = new Set([40003]);

/** Characters allowed in one Coverage reference segment. */
const COVERAGE_PART = /^[A-Za-z0-9_().\-\u4e00-\u9fff]{1,180}$/;
const UNSAFE_JOB_CHARS = new Set(["/", "\\", "?", "#", "%", " ", "\t", "\r", "\n"]);
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface OgeClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  successCodes?: Iterable<number>;
  maxPreviewBytes?: number;
  fetchFn?: FetchLike;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OgeCatalogPage {
  items: Record<string, unknown>[];
  total: number;
  pageNum: number;
  pageSize: number;
  totalPages: number;
}

export interface OgeProcessResult {
  raw: Record<string, unknown>;
  taskId: string;
  taskName: string;
}

const ID_KEYS = ["recordId", "id", "processId", "taskId", "jobId"] as const;
const NAME_KEYS = ["taskName", "name", "output", "recordName"] as const;

export class OgeClient {
  readonly endpoint: string;
  readonly successCodes: ReadonlySet<number>;
  private readonly timeoutMs: number;
  private readonly maxPreviewBytes: number;
  private readonly fetchFn: FetchLike;

  constructor(options: OgeClientOptions = {}) {
    this.endpoint = (options.endpoint ?? OGE_API_BASE).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.successCodes = new Set(options.successCodes ?? OGE_SUCCESS_CODES);
    this.maxPreviewBytes = options.maxPreviewBytes ?? 4 * 1024 * 1024;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  // ── Coverage references ────────────────────────────────────────────────

  /**
   * Build `Platform:Coverage:<image>:<product>`.
   *
   * The format is positional and colon-separated: a typo does not error, it
   * silently computes something else. Segments are allow-listed because the
   * reference is interpolated into an OGE query.
   */
  static coverageRef(imageIdentification: string, productName: string): string {
    // Colon first: it is the most common mistake, so it deserves a direct message.
    if (`${imageIdentification}${productName}`.includes(":")) {
      throw new Error("Coverage reference segments must not contain ':'");
    }
    for (const [label, value] of [
      ["imageIdentification", imageIdentification],
      ["productName", productName],
    ] as const) {
      if (!value) throw new Error(`Coverage reference missing ${label}`);
      if (!COVERAGE_PART.test(value)) {
        const bad = [...new Set([...value].filter((ch) => !COVERAGE_PART.test(ch)))];
        throw new Error(
          `Coverage reference ${label} contains disallowed characters ${JSON.stringify(bad)}: ` +
            `only letters, digits, underscore, dot, parentheses, hyphen and CJK are allowed`,
        );
      }
    }
    return `Platform:Coverage:${imageIdentification}:${productName}`;
  }

  /** The `coverage` argument shape OGE expects. */
  static coverageArg(
    imageIdentification: string,
    productName: string,
    pretreatment = false,
  ): Record<string, unknown> {
    return {
      type: "Coverage",
      value: [OgeClient.coverageRef(imageIdentification, productName)],
      pretreatment,
    };
  }

  /** Result preview URL. Rejects path/query injection in `processId`. */
  getCogUrl(processId: string): string {
    if (!processId) throw new Error("COG URL requires a processId");
    const unsafe = [...processId].filter((ch) => UNSAFE_JOB_CHARS.has(ch));
    if (unsafe.length > 0 || processId.includes("..")) {
      throw new Error(
        `processId contains disallowed characters ${JSON.stringify(unsafe.length ? unsafe : [".."])}`,
      );
    }
    return `${this.endpoint}/computation-api/styles/cog/${processId}`;
  }

  // ── Catalog ────────────────────────────────────────────────────────────

  /** Products. `dataType`: 0 = raster, 1 = vector. */
  async listDataProducts(options: {
    dataType?: 0 | 1;
    pageNum?: number;
    pageSize?: number;
    keywords?: string;
    status?: number;
  } = {}): Promise<OgeCatalogPage> {
    const pageNum = options.pageNum ?? 1;
    const pageSize = options.pageSize ?? 20;
    const payload: Record<string, unknown> = {
      pageNum,
      pageSize,
      status: options.status ?? 1,
      type: options.dataType ?? 0,
    };
    if (options.keywords) payload["keywords"] = options.keywords;

    const data = await this.request("POST", "/data-product/page", { json: payload });
    return pageOf(data, pageNum, pageSize);
  }

  /** Images (individual scenes) of one product. */
  async listImages(
    productId: number | string,
    options: { pageNum?: number; pageSize?: number; imageIdentification?: string } = {},
  ): Promise<OgeCatalogPage> {
    const pageNum = options.pageNum ?? 1;
    const pageSize = options.pageSize ?? 50;
    const query: Record<string, string> = {
      productId: String(productId),
      // NOTE: images uses pageNum while result search uses pageNumber.
      pageNum: String(pageNum),
      pageSize: String(pageSize),
    };
    if (options.imageIdentification) query["imageIdentification"] = options.imageIdentification;

    const data = await this.request("GET", "/data-product/image/pageByProductId", { query });
    return pageOf(data, pageNum, pageSize);
  }

  /** A PNG display preview. 8-bit rendering, **not** source pixel data. */
  async getImagePreview(imageId: number | string): Promise<Uint8Array> {
    const parsed = typeof imageId === "number" ? imageId : Number(imageId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`imageId must be a positive integer, got ${JSON.stringify(imageId)}`);
    }
    const url = new URL(`${this.endpoint}/data-product/image/getImagePreview`);
    url.searchParams.set("imageId", String(parsed));
    const response = await this.fetchFn(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new OgeError(
        `OGE did not provide a preview for this image (${response.status})`,
        response.status,
        (await response.text()).slice(0, 300),
      );
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > this.maxPreviewBytes) {
      throw new OgeError(
        `OGE preview exceeds ${this.maxPreviewBytes} bytes (${buffer.byteLength})`,
        response.status,
      );
    }
    const looksPng = PNG_MAGIC.every((byte, i) => buffer[i] === byte);
    if (!looksPng) {
      throw new OgeError(
        "OGE did not return a valid PNG preview (magic bytes mismatch)",
        response.status,
      );
    }
    return buffer;
  }

  /** Vector product detail. */
  async getVectorProduct(productId: number | string): Promise<Record<string, unknown>> {
    return this.request("GET", "/data-product/vector-product/get", {
      query: { productId: String(productId) },
    });
  }

  /** Vector spatial metadata. Requires a Bearer JWT — not anonymous. */
  async getVectorSpatialMetadata(
    tableName: string,
    jwtToken?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (jwtToken) headers["authorization"] = `Bearer ${jwtToken}`;
    return this.request("GET", "/management/vector-product/getSpatialMetadata", {
      query: { tableName },
      headers,
    });
  }

  // ── Compute ────────────────────────────────────────────────────────────

  /**
   * Submit via the documented form: `POST /computation-api/process` with
   * `{name, args}` and a Bearer JWT.
   */
  async submitProcess(
    processName: string,
    args: Record<string, unknown>,
    jwtToken?: string,
  ): Promise<{ processId: string }> {
    const headers: Record<string, string> = {};
    if (jwtToken) headers["authorization"] = `Bearer ${jwtToken}`;
    const data = await this.request("POST", "/computation-api/process", {
      json: { name: processName, args },
      headers,
    });
    const processId = pickString(data, ["processId", "id", "jobId", "recordId"]);
    if (!processId) {
      throw new OgeExecutionError(
        "Submit process failed: no process id in response",
        undefined,
        200,
      );
    }
    return { processId };
  }

  /** Past computation results. Note the `pageNumber` spelling here. */
  async searchProcessResults(options: {
    pageNumber?: number;
    pageSize?: number;
    queryTaskName?: string;
    jwtToken?: string;
  } = {}): Promise<OgeProcessResult[]> {
    const headers: Record<string, string> = {};
    if (options.jwtToken) headers["authorization"] = `Bearer ${options.jwtToken}`;
    const data = await this.request("POST", "/asset/algorithm-processing-result/search", {
      json: {
        pageNumber: options.pageNumber ?? 1,
        pageSize: options.pageSize ?? 20,
        queryTaskName: options.queryTaskName ?? "",
      },
      headers,
    });
    const page = pageOf(data, options.pageNumber ?? 1, options.pageSize ?? 20);
    return page.items.map((raw) => ({
      raw,
      taskId: pickString(raw, [...ID_KEYS]),
      taskName: pickString(raw, [...NAME_KEYS]),
    }));
  }

  /**
   * Operator definition. **Not anonymous**: without `tk` the service answers
   * `40003 无效token`, so we refuse locally with a clear message instead.
   */
  async getProcessInfo(
    processName: string,
    tk?: string,
  ): Promise<{ processName: string; inputs: unknown[]; outputs: unknown[] }> {
    if (!tk) {
      throw new OgeAuthError(
        "Querying an operator definition requires tk: " +
          "OGE's /computation-api/process/info is not an anonymous endpoint",
      );
    }
    const data = await this.request("GET", "/computation-api/process/info", {
      query: { processName, tk },
    });
    return {
      processName: pickString(data, ["processName", "name"]) ?? processName,
      inputs: Array.isArray(data["inputs"]) ? (data["inputs"] as unknown[]) : [],
      outputs: Array.isArray(data["outputs"]) ? (data["outputs"] as unknown[]) : [],
    };
  }

  // ── Transport ──────────────────────────────────────────────────────────

  /** One JSON request, with business-code checking. Returns the unwrapped `data`. */
  private async request(
    method: string,
    path: string,
    options: {
      json?: unknown;
      query?: Record<string, string>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.endpoint}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.json !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (options.json !== undefined) init.body = JSON.stringify(options.json);
    try {
      response = await this.fetchFn(url.toString(), init);
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";
      throw new OgeError(
        aborted
          ? `OGE request timed out after ${this.timeoutMs}ms (${method} ${path})`
          : `OGE transport error (${method} ${path}): ${String(cause)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      throw new OgeAuthError(
        `OGE auth failed (${response.status}): ${text.slice(0, 200)}`,
        response.status,
        text,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new OgeError(
        `OGE API error (${response.status}): ${text.slice(0, 300)}`,
        response.status,
        text,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OgeError(`OGE returned non-JSON (${method} ${path})`, response.status, text);
    }

    // Bare arrays are a legitimate response shape for some endpoints.
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { data: body };
    }
    const envelope = body as Record<string, unknown>;
    if (!("code" in envelope)) return envelope;

    const code = envelope["code"];
    if (typeof code === "number" && this.successCodes.has(code)) {
      const data = envelope["data"];
      return typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { data };
    }
    const message = String(envelope["msg"] ?? envelope["message"] ?? "unknown");
    if (typeof code === "number" && OGE_AUTH_ERROR_CODES.has(code)) {
      throw new OgeAuthError(`OGE auth failed (code=${code}): ${message}`, response.status, text);
    }
    throw new OgeError(`OGE biz error (code=${String(code)}): ${message}`, response.status, text);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function pickString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

/** Parse a paged body, tolerating the shell variants OGE uses. */
function pageOf(data: Record<string, unknown>, pageNum: number, pageSize: number): OgeCatalogPage {
  const items = extractItems(data);
  const total = typeof data["total"] === "number" ? data["total"] : items.length;
  let totalPages = 1;
  for (const key of ["pages", "totalPages", "pageCount"]) {
    const value = data[key];
    if (typeof value === "number") {
      totalPages = Math.max(1, value);
      break;
    }
  }
  return { items, total, pageNum, pageSize, totalPages };
}

function extractItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["records", "list", "rows", "items", "content", "data"]) {
    const value = record[key];
    if (Array.isArray(value)) return extractItems(value);
    if (typeof value === "object" && value !== null) {
      const nested = extractItems(value);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}
