/**
 * GeoCard: the unit of description in GeoNexus.
 *
 * Validation is driven by the **published** schema at
 * ``schemas/geocard.schema.json``, which is bundled byte-for-byte in this
 * package (a test asserts that). That is deliberate: three SDKs (Python,
 * TypeScript, Rust) plus the Java side must agree on exactly one contract, so
 * each port validates against the same file rather than a hand-copy.
 *
 * Layering note, mirrored from the Python SDK: `parseGeoCard` is permissive and
 * `validateGeoCard` is strict. Keeping them separate lets tooling inspect and
 * repair malformed cards instead of refusing to look at them.
 */

import { GeoCardValidationError } from "./errors.js";
import { assertSchemaIsSupported, validate, type Schema } from "./jsonschema.js";
// Bundled copy of schemas/geocard.schema.json — kept identical by a test.
import geocardSchema from "./geocard.schema.json" with { type: "json" };

/** Asset kinds allowed by the published contract. */
export const GEOCARD_TYPES = [
  "data",
  "model",
  "skill",
  "agent",
  "workflow",
  "knowledge",
  "compute",
] as const;

export type GeoCardType = (typeof GEOCARD_TYPES)[number];

export interface SpatialSection {
  bbox?: number[];
  crs?: string;
  resolution?: number;
  geometryType?: string;
  [key: string]: unknown;
}

export interface AccessSection {
  protocol?: string;
  endpoint?: string;
  auth?: string;
  format?: string;
  [key: string]: unknown;
}

export interface Capability {
  name: string;
  description?: string;
}

export interface RuntimeSection {
  cpu?: number | string;
  memory?: string;
  gpu?: string;
  [key: string]: unknown;
}

export interface ProvenanceSection {
  provider?: string;
  source?: string;
  lineage?: string;
  [key: string]: unknown;
}

export interface ComplianceSection {
  sovereignty?: string;
  restrictions?: string[];
  sensitivity?: "public" | "restricted" | "sensitive" | "secret" | string;
  [key: string]: unknown;
}

/**
 * A GeoCard document.
 *
 * `type` is typed loosely on purpose: the model must be able to represent an
 * invalid card so callers can inspect it. {@link validateGeoCard} enforces the
 * enum.
 */
export interface GeoCard {
  geocard_version: string;
  id: string;
  type: string;
  name: string;
  description: string;
  tags?: string[];
  knowledge_refs?: string[];
  spatial?: SpatialSection;
  temporal?: Record<string, unknown>;
  bands?: Array<Record<string, unknown>>;
  inputs?: Array<Record<string, unknown>>;
  outputs?: Array<Record<string, unknown>>;
  capabilities?: Array<Capability | string>;
  access?: AccessSection;
  provenance?: ProvenanceSection;
  license?: string | Record<string, unknown>;
  compliance?: ComplianceSection;
  trust?: Record<string, unknown>;
  runtime?: RuntimeSection;
  interface?: Record<string, unknown>;
  io?: Record<string, unknown>;
  provides?: string[];
  [key: string]: unknown;
}

const schema = geocardSchema as Schema;

// Fail at import time if the bundled schema grows a keyword we cannot enforce.
assertSchemaIsSupported(schema);

/** Every schema violation, as human-readable strings. Empty means valid. */
export function geocardErrors(card: unknown): string[] {
  return validate(schema, card);
}

/**
 * Validate a card, throwing {@link GeoCardValidationError} on failure.
 *
 * Returns the same object (narrowed) so call sites can chain:
 * `const card = validateGeoCard(build())`.
 */
export function validateGeoCard(card: unknown): GeoCard {
  const errors = geocardErrors(card);
  if (errors.length > 0) throw new GeoCardValidationError(errors);
  return card as GeoCard;
}

/** Parse without contract validation — for inspecting cards you did not write. */
export function parseGeoCard(card: unknown): GeoCard {
  if (typeof card !== "object" || card === null || Array.isArray(card)) {
    throw new GeoCardValidationError(["$: expected a GeoCard object"]);
  }
  const record = card as Record<string, unknown>;
  for (const key of ["geocard_version", "id", "type", "name", "description"]) {
    if (typeof record[key] !== "string") {
      throw new GeoCardValidationError([`$: missing required string "${key}"`]);
    }
  }
  return record as unknown as GeoCard;
}

/** Names a card advertises, accepting both the string and object capability forms. */
export function capabilityNames(card: GeoCard): string[] {
  const raw = card.capabilities ?? [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") names.push(entry);
    else if (entry !== null && typeof entry === "object" && typeof entry.name === "string") {
      names.push(entry.name);
    }
  }
  return names;
}

/**
 * Fluent builder, mirroring `GeoCardBuilder` in the Python SDK.
 *
 * Example:
 * ```ts
 * const card = new GeoCardBuilder("my-asset", "data", "My Asset", "Desc")
 *   .spatial({ bbox: [100, 20, 110, 30], crs: "EPSG:4326" })
 *   .capability("ndvi")
 *   .build();
 * ```
 */
export class GeoCardBuilder {
  private readonly card: GeoCard;

  constructor(id: string, type: GeoCardType, name: string, description: string) {
    this.card = {
      geocard_version: "1.0",
      id,
      type,
      name,
      description,
      tags: [],
    };
  }

  spatial(section: SpatialSection): this {
    this.card.spatial = section;
    return this;
  }

  temporal(section: Record<string, unknown>): this {
    this.card.temporal = section;
    return this;
  }

  access(section: AccessSection): this {
    this.card.access = section;
    return this;
  }

  capability(name: string, description?: string): this {
    const list = (this.card.capabilities ??= []);
    list.push(description ? { name, description } : { name });
    return this;
  }

  tag(tag: string): this {
    const tags = (this.card.tags ??= []);
    if (!tags.includes(tag)) tags.push(tag);
    return this;
  }

  provenance(section: ProvenanceSection): this {
    this.card.provenance = section;
    return this;
  }

  license(value: string | Record<string, unknown>): this {
    this.card.license = value;
    return this;
  }

  compliance(section: ComplianceSection): this {
    this.card.compliance = section;
    return this;
  }

  runtime(section: RuntimeSection): this {
    this.card.runtime = section;
    return this;
  }

  /** Merge an arbitrary extra field (e.g. ``x-geonexus``). */
  set(key: string, value: unknown): this {
    this.card[key] = value;
    return this;
  }

  /** Build without validating — use when you still need to inspect gaps. */
  buildUnsafe(): GeoCard {
    return this.card;
  }

  /** Build and validate; throws {@link GeoCardValidationError} if incomplete. */
  build(): GeoCard {
    return validateGeoCard(this.card);
  }
}
