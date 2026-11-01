/**
 * Error types shared by every client in this SDK.
 *
 * Design note: the Python SDK exposes parallel classes
 * (``GeoCardValidationError`` / ``GeoMCPProtocolError`` / ``RegistryError`` /
 * ``OgeClientError``). Names are kept recognisable across languages so that
 * log lines and docs match, while the *casing* follows TypeScript convention.
 */

/** A GeoCard failed schema validation. Carries every error, not just the first. */
export class GeoCardValidationError extends Error {
  public readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(
      errors.length === 0
        ? "GeoCard validation failed"
        : `GeoCard validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}`,
    );
    this.name = "GeoCardValidationError";
    this.errors = errors;
  }
}

/**
 * GeoMCP application error codes.
 *
 * Two disjoint ranges, and mixing them up breaks client retry logic:
 *   - JSON-RPC 2.0 reserved codes are **negative** (must not be invented)
 *   - GeoNexus application codes live in the positive 2xxx space
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export const GeoMcpErrorCode = {
  ContractNotSatisfied: 2000,
  SkillNotFound: 2001,
  GeoCardNotFound: 2002,
  ExecutionFailed: 2003,
  InvalidArgument: 2004,
  RecipeNotFound: 2005,
  RecipeParamInvalid: 2006,
  ContractBindingRejected: 2007,
  PushdownUnresolved: 2008,
  FederationUnresolved: 2009,
} as const;

export type JsonRpcErrorCodeValue =
  (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];
export type GeoMcpErrorCodeValue = (typeof GeoMcpErrorCode)[keyof typeof GeoMcpErrorCode];

/** An error returned by a GeoMCP server (or a transport-level failure). */
export class GeoMcpError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "GeoMcpError";
    this.code = code;
    this.data = data;
  }

  /** True for the JSON-RPC reserved range (transport/protocol level). */
  get isProtocolLevel(): boolean {
    return this.code < 0;
  }

  /** Human-readable category, useful in logs. */
  get category(): string {
    if (this.isProtocolLevel) return "protocol";
    const name = Object.entries(GeoMcpErrorCode).find(([, v]) => v === this.code)?.[0];
    return name ?? "unknown-application-error";
  }
}

/** A GeoCard Registry rejected or failed a request. */
export class RegistryError extends Error {
  public readonly status:
    | number
    | undefined;
  public readonly body: unknown;

  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
    this.body = body;
  }
}

/** Base class for OGE client failures. */
export class OgeError extends Error {
  public readonly status: number | undefined;
  public readonly body: string | undefined;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "OgeError";
    this.status = status;
    this.body = body;
  }
}

/** OGE authentication failure (token missing, expired, or rejected). */
export class OgeAuthError extends OgeError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = "OgeAuthError";
  }
}

/** An OGE execution failed, and we know (or do not know) the process id. */
export class OgeExecutionError extends OgeError {
  public readonly processId: string | undefined;

  constructor(message: string, processId?: string, status?: number) {
    super(message, status);
    this.name = "OgeExecutionError";
    this.processId = processId;
  }
}
