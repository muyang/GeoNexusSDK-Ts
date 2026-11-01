/**
 * OGE assets → GeoCard.
 *
 * The discipline is the same as `geonexus.adapters.oge_asset_cards` in Python:
 * **write what the source actually says, never a plausible default.**
 *
 * That is why `computeResourceCard` leaves `runtime` absent when no specs were
 * declared. An empty field tells the scheduler "unknown"; a guessed `cpu: 4`
 * tells it "four cores", and it will schedule onto a box that cannot take it.
 */

import type { GeoCard } from "./geocard.js";
import { validateGeoCard } from "./geocard.js";

export interface CardBuildResult {
  card: GeoCard;
  warnings: string[];
}

function slug(text: string, maxLength = 32): string {
  // GeoCard ids are ASCII-only by contract, so CJK names collapse to the hash.
  // The original name survives in `name`.
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return cleaned || "asset";
}

/** FNV-1a: small, dependency-free, stable across runs and languages. */
function digest(target: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < target.length; i += 1) {
    hash ^= target.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "" && !isEmptyArray(value)) {
      return value;
    }
  }
  return undefined;
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length < 4 || value.length > 6) return undefined;
  const numbers: number[] = [];
  for (const item of value) {
    const num = typeof item === "number" ? item : Number(item);
    if (!Number.isFinite(num)) return undefined;
    numbers.push(num);
  }
  return numbers;
}

/**
 * Derive a bbox from the four corner lat/lons that raster images actually use
 * (`upperLeftLat` / `upperLeftLong` / `upperRight*` / `lowerLeft*` / `lowerRight*`).
 *
 * Min/max rather than positional order: corners can swap across the antimeridian.
 */
export function bboxFromCorners(source: Record<string, unknown>): number[] | undefined {
  const lons: number[] = [];
  const lats: number[] = [];
  for (const [key, value] of Object.entries(source)) {
    const lowered = key.toLowerCase();
    if (!lowered.includes("upper") && !lowered.includes("lower")) continue;
    if (!lowered.includes("left") && !lowered.includes("right")) continue;
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) continue;
    if (lowered.includes("lon")) lons.push(num);
    else if (lowered.includes("lat")) lats.push(num);
  }
  if (lons.length < 2 || lats.length < 2) return undefined;

  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  // Reject projected coordinates: they would be labelled EPSG:4326 and be wrong.
  if (minLon < -180 || maxLon > 180) return undefined;
  if (minLat < -90 || maxLat > 90) return undefined;
  if (minLon >= maxLon || minLat >= maxLat) return undefined; // a point, not an extent
  return [round6(minLon), round6(minLat), round6(maxLon), round6(maxLat)];
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** bbox for the shapes OGE actually returns, plus explicit bbox fields. */
export function bboxFrom(source: Record<string, unknown>): number[] | undefined {
  const direct = asNumberArray(pick(source, ["bbox", "boundingBox", "extent", "spatialExtent"]));
  if (direct) return direct;

  const corners = bboxFromCorners(source);
  if (corners) return corners;

  for (const combo of [
    ["minX", "minY", "maxX", "maxY"],
    ["minLon", "minLat", "maxLon", "maxLat"],
  ]) {
    if (combo.every((k) => source[k] !== undefined && source[k] !== null)) {
      const box = asNumberArray(combo.map((k) => source[k]));
      // Same 6-decimal normalisation as the corner path, so both sources of
      // extent produce comparable bbox values.
      if (box) return box.map(round6);
    }
  }
  return undefined;
}

function baseCard(input: {
  id: string;
  type: string;
  name: string;
  description: string;
  provider: string;
  endpoint: string;
  tags: string[];
  protocol: string;
  format?: string | undefined;
  auth?: string | undefined;
  bbox?: number[] | undefined;
  crs?: string | undefined;
  licenseName?: string | undefined;
  sensitivity?: string | undefined;
}): GeoCard {
  const card: GeoCard = {
    geocard_version: "1.0",
    id: input.id,
    type: input.type,
    name: input.name,
    description: input.description,
    tags: [...new Set(input.tags)].sort(),
    compliance: { sensitivity: input.sensitivity ?? "public" },
    provenance: { provider: input.provider, source: input.endpoint },
    // Public registries require an explicit revision.
    "x-geonexus": { revision: "1.0.0" },
    access: {
      protocol: input.protocol,
      endpoint: input.endpoint,
      ...(input.format ? { format: input.format } : {}),
      ...(input.auth ? { auth: input.auth } : {}),
    },
  };
  if (input.licenseName) card.license = input.licenseName;
  if (input.bbox) card.spatial = { bbox: input.bbox, crs: input.crs ?? "EPSG:4326" };
  return card;
}

export interface RasterCardOptions {
  endpoint: string;
  image?: Record<string, unknown>;
  licenseName?: string;
  sensitivity?: string;
  provider?: string;
}

/** Raster product (optionally one specific scene) → data card. */
export function rasterProductCard(
  product: Record<string, unknown>,
  options: RasterCardOptions,
): CardBuildResult {
  const productId = pick(product, ["id", "productId"]);
  let name = String(pick(product, ["name", "productName", "keywords", "title"]) ?? "");
  if (!name) name = productId === undefined ? "oge-product" : `oge-product-${String(productId)}`;

  if (options.image) {
    const ident = pick(options.image, [
      "imageIdentification",
      "identification",
      "name",
      "imageName",
    ]);
    if (ident) name = String(ident);
  }

  const source = options.image ?? product;
  const bbox = bboxFrom(source) ?? bboxFrom(product);
  const warnings: string[] = [];
  if (!bbox) warnings.push("No spatial extent found: the card carries no `spatial`");
  if (!options.licenseName) warnings.push("No license declared (`license`) — confirm before publishing");
  if (productId === undefined) warnings.push("Product has no id: cannot re-query its images");

  const card = baseCard({
    id: `oge.raster.${slug(name)}-${digest(`${options.endpoint}:${name}`)}`,
    type: "data",
    name,
    description: String(
      pick(product, ["description", "desc", "remark"]) ??
        `OGE raster product${productId === undefined ? "" : ` (id=${String(productId)})`}`,
    ),
    provider: options.provider ?? "OGE",
    endpoint: options.endpoint,
    tags: ["oge", "raster", "imported"],
    protocol: "https",
    format: String(pick(product, ["format", "dataFormat"]) ?? "COG"),
    bbox,
    crs: pick(product, ["crs", "srs", "epsg"]) as string | undefined,
    licenseName: options.licenseName,
    sensitivity: options.sensitivity,
  });
  return { card, warnings };
}

export interface VectorCardOptions {
  endpoint: string;
  spatial?: Record<string, unknown>;
  licenseName?: string;
  sensitivity?: string;
  provider?: string;
}

/** Vector product (plus optional spatial metadata) → data card. */
export function vectorProductCard(
  product: Record<string, unknown>,
  options: VectorCardOptions,
): CardBuildResult {
  const productId = pick(product, ["id", "productId"]);
  const name =
    String(pick(product, ["name", "productName", "title"]) ?? "") ||
    (productId === undefined ? "oge-vector" : `oge-vector-${String(productId)}`);
  const table =
    pick(product, ["tableName", "table", "physicalTable"]) ??
    pick(options.spatial ?? {}, ["tableName"]);

  const merged = { ...(options.spatial ?? {}), ...product };
  const bbox = bboxFrom(options.spatial ?? {}) ?? bboxFrom(product);

  const warnings: string[] = [];
  if (!bbox) warnings.push("No vector spatial extent found: the card carries no `spatial`");
  if (!options.licenseName) warnings.push("No license declared (`license`) — confirm before publishing");
  if (!table) warnings.push("No physical table name (`tableName`): cannot query spatial metadata");

  const card = baseCard({
    id: `oge.vector.${slug(name)}-${digest(`${options.endpoint}:${name}`)}`,
    type: "data",
    name,
    description: String(
      pick(product, ["description", "desc", "remark"]) ??
        `OGE vector product${table ? ` (table ${String(table)})` : ""}`,
    ),
    provider: options.provider ?? "OGE",
    endpoint: options.endpoint,
    tags: ["oge", "vector", "imported"],
    protocol: "https",
    format: String(pick(merged, ["format", "dataFormat"]) ?? "GeoJSON"),
    bbox,
    crs: pick(merged, ["crs", "srs", "epsg"]) as string | undefined,
    licenseName: options.licenseName,
    sensitivity: options.sensitivity,
  });
  return { card, warnings };
}

export interface OperatorCardOptions {
  endpoint: string;
  inputs?: Array<Record<string, unknown>>;
  outputs?: Array<Record<string, unknown>>;
  description?: string;
  version?: string;
  provider?: string;
  licenseName?: string;
  capabilities?: string[];
}

/**
 * OGE operator → `type: skill` card.
 *
 * `capabilities` must be declared: the registry's `search(capability=...)`
 * reads this field, and tags do not count. A card without it registers fine
 * and is then never found.
 */
export function operatorCard(
  processName: string,
  options: OperatorCardOptions,
): CardBuildResult {
  const warnings: string[] = [];
  if (!options.inputs || options.inputs.length === 0) {
    warnings.push("No operator input definition: contract checks cannot verify argument names");
  }
  if (processName.includes(":")) {
    warnings.push("Operator name contains ':', which looks like a Coverage reference");
  }

  let capabilities = options.capabilities ?? [];
  if (capabilities.length === 0) {
    const tail = processName.split(".").pop() ?? processName;
    const derived = tail
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (derived) {
      capabilities = [derived];
      warnings.push(
        `No capability declared; derived '${derived}' from the operator name — ` +
          `declare business capabilities explicitly before publishing`,
      );
    }
  }

  const card = baseCard({
    id: `oge.operator.${slug(processName)}-${digest(`${options.endpoint}:${processName}`)}`,
    type: "skill",
    name: processName,
    description: options.description ?? `OGE operator ${processName}`,
    provider: options.provider ?? "OGE",
    endpoint: options.endpoint,
    tags: ["oge", "operator", "skill", ...capabilities],
    protocol: "oge",
    auth: "tk",
    licenseName: options.licenseName,
  });

  card.interface = { type: "oge-process", version: options.version ?? "1.0" };
  card.capabilities = capabilities.map((name) => ({ name }));
  if (options.inputs && options.inputs.length > 0) {
    card.io = { inputs: options.inputs, outputs: options.outputs ?? [] };
    const extra = (card["x-geonexus"] ?? {}) as Record<string, unknown>;
    extra["input_schema"] = paramsToSchema(options.inputs);
    extra["output_schema"] = paramsToSchema(options.outputs ?? []);
    card["x-geonexus"] = extra;
  } else {
    warnings.push(
      "Missing operator definition, so no input_schema/output_schema: " +
        "this card can be registered internally but public registries will reject it",
    );
  }
  return { card, warnings };
}

const PARAM_TYPE: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  coverage: "string", // a Coverage reference is a string on the wire
  object: "object",
  array: "array",
};

/** OGE parameter table → JSON Schema (Draft 2020-12). */
export function paramsToSchema(params: Array<Record<string, unknown>>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of params) {
    const name = param["name"];
    if (typeof name !== "string" || name.length === 0) continue;
    const rawType = String(param["type"] ?? "string").toLowerCase();
    const property: Record<string, unknown> = {
      type: PARAM_TYPE[rawType] ?? "string",
    };
    if (typeof param["description"] === "string") property["description"] = param["description"];
    properties[name] = property;
    required.push(name);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
    additionalProperties: true,
  };
}

export interface ComputeCardOptions {
  endpoint: string;
  name?: string;
  cpu?: number;
  memory?: string;
  gpu?: string;
  operators?: string[];
  backends?: string[];
  provider?: string;
  licenseName?: string;
}

/**
 * OGE compute resource → `type: compute` card.
 *
 * `cpu` / `memory` / `gpu` are **not** probed: no OGE endpoint exposes them
 * (verified against the docs, the Platform adapter and the live service), so
 * they must be declared by the operator. Nothing is invented here.
 */
export function computeResourceCard(options: ComputeCardOptions): CardBuildResult {
  const warnings: string[] = [];
  if (options.cpu === undefined && !options.memory && !options.gpu) {
    warnings.push("No compute specs declared: the scheduler cannot judge capacity");
  }
  if (!options.operators || options.operators.length === 0) {
    warnings.push("No operator list declared: can only be registered as a pool, not routed by capability");
  }
  if (options.cpu !== undefined && (!Number.isInteger(options.cpu) || options.cpu < 1)) {
    warnings.push("Public registries require runtime.cpu to be a positive integer");
  }
  if (!options.memory) {
    warnings.push("Public registries require runtime.memory (e.g. '32Gi')");
  }

  const name = options.name ?? "oge-compute";
  const card = baseCard({
    id: `oge.compute.${slug(name)}-${digest(`${options.endpoint}:${name}`)}`,
    type: "compute",
    name,
    description: `OGE compute resource (${options.endpoint})`,
    provider: options.provider ?? "OGE",
    endpoint: options.endpoint,
    tags: ["oge", "compute"],
    protocol: "geomcp",
    auth: "tk",
    licenseName: options.licenseName,
  });

  const extra = (card["x-geonexus"] ?? {}) as Record<string, unknown>;
  extra["backends"] = options.backends ?? ["oge"];
  card["x-geonexus"] = extra;

  const runtime: Record<string, unknown> = {};
  if (options.cpu !== undefined) runtime["cpu"] = options.cpu;
  if (options.memory) runtime["memory"] = options.memory;
  if (options.gpu) runtime["gpu"] = options.gpu;
  if (Object.keys(runtime).length > 0) card.runtime = runtime;
  if (options.operators && options.operators.length > 0) {
    card.provides = [...new Set(options.operators)].sort();
  }
  return { card, warnings };
}

/** Validate and return the card, throwing on contract violations. */
export function checkedCard(result: CardBuildResult): GeoCard {
  return validateGeoCard(result.card);
}
