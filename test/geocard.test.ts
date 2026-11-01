/**
 * GeoCard contract tests.
 *
 * The first test is the important one: it asserts the bundled schema is
 * byte-identical to ``schemas/geocard.schema.json``. Three SDKs validate
 * against that file, so a copy that drifts would make "valid in TypeScript,
 * invalid in Python" possible — the exact failure this suite exists to prevent.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GeoCardBuilder,
  GEOCARD_TYPES,
  GeoCardValidationError,
  capabilityNames,
  geocardErrors,
  parseGeoCard,
  validateGeoCard,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoSchema = join(here, "..", "schemas", "geocard.schema.json");
const bundledSchema = join(here, "..", "src", "geocard.schema.json");

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    geocard_version: "1.0",
    id: "asset-1",
    type: "data",
    name: "Asset",
    description: "An asset.",
    ...overrides,
  };
}

test("bundled schema is identical to the repository schema", () => {
  const a = readFileSync(repoSchema);
  const b = readFileSync(bundledSchema);
  assert.equal(
    Buffer.compare(a, b),
    0,
    "sdk-ts/src/geocard.schema.json has drifted from schemas/geocard.schema.json",
  );
});

test("schema type enum matches GEOCARD_TYPES", () => {
  const schema = JSON.parse(readFileSync(bundledSchema, "utf8")) as {
    properties: { type: { enum: string[] } };
  };
  assert.deepEqual([...schema.properties.type.enum].sort(), [...GEOCARD_TYPES].sort());
});

test("accepts a minimal valid card", () => {
  const card = validateGeoCard(minimal());
  assert.equal(card.id, "asset-1");
});

test("reports every missing required field, not just the first", () => {
  const errors = geocardErrors({ geocard_version: "1.0" });
  const joined = errors.join("\n");
  for (const field of ["id", "type", "name", "description"]) {
    assert.match(joined, new RegExp(field), `missing-field error for ${field} should be reported`);
  }
  assert.ok(errors.length >= 4, `expected >= 4 errors, got ${errors.length}`);
});

test("rejects an id with disallowed characters", () => {
  const errors = geocardErrors(minimal({ id: "bad id/with slash" }));
  assert.ok(errors.some((e) => e.includes("pattern") || e.includes("does not match")));
});

test("rejects a type outside the published enum", () => {
  const errors = geocardErrors(minimal({ type: "not-a-real-type" }));
  assert.ok(errors.some((e) => e.includes("must be one of")));
});

test("the model stays permissive so malformed cards can be inspected", () => {
  // Mirrors Python's `load_geocard(validate=False)`: tooling must be able to
  // look at a broken card instead of refusing to open it.
  const card = parseGeoCard(minimal({ type: "not-a-real-type" }));
  assert.equal(card.type, "not-a-real-type");
});

test("validateGeoCard throws GeoCardValidationError", () => {
  assert.throws(() => validateGeoCard({}), GeoCardValidationError);
});

test("parseGeoCard rejects non-objects and missing strings", () => {
  assert.throws(() => parseGeoCard([]), GeoCardValidationError);
  assert.throws(() => parseGeoCard(null), GeoCardValidationError);
  assert.throws(() => parseGeoCard({ geocard_version: "1.0" }), GeoCardValidationError);
});

test("bbox must have 4..6 numeric entries", () => {
  assert.equal(geocardErrors(minimal({ spatial: { bbox: [1, 2, 3, 4] } })).length, 0);
  assert.ok(geocardErrors(minimal({ spatial: { bbox: [1, 2, 3] } })).length > 0);
  assert.ok(geocardErrors(minimal({ spatial: { bbox: [1, 2, 3, "x"] } })).length > 0);
});

test("capabilities accept the string and object forms", () => {
  assert.equal(geocardErrors(minimal({ capabilities: ["ndvi"] })).length, 0);
  assert.equal(geocardErrors(minimal({ capabilities: [{ name: "ndvi" }] })).length, 0);
  // Object form forbids extra keys
  assert.ok(geocardErrors(minimal({ capabilities: [{ name: "ndvi", extra: 1 }] })).length > 0);
});

test("capabilityNames normalises both forms", () => {
  const card = validateGeoCard(
    minimal({ capabilities: ["ndvi", { name: "ndwi", description: "water" }] }),
  );
  assert.deepEqual(capabilityNames(card), ["ndvi", "ndwi"]);
});

test("extra properties are allowed (adapters carry x-geonexus)", () => {
  const card = validateGeoCard(
    minimal({ "x-geonexus": { revision: "1.0.0" }, access: { protocol: "https" } }),
  );
  assert.deepEqual(card["x-geonexus"], { revision: "1.0.0" });
});

test("builder produces a card that validates", () => {
  const card = new GeoCardBuilder("b-1", "data", "Built", "Built by the builder.")
    .spatial({ bbox: [100, 20, 110, 30], crs: "EPSG:4326" })
    .capability("ndvi")
    .tag("demo")
    .build();
  assert.equal(card.id, "b-1");
  assert.deepEqual(capabilityNames(card), ["ndvi"]);
});

test("builder can be inspected before validation", () => {
  // A 3-item bbox violates the contract (needs 4..6). buildUnsafe must still
  // hand the object back so tooling can look at what is wrong.
  const builder = new GeoCardBuilder("p-1", "data", "Partial", "desc").set("spatial", {
    bbox: [1, 2, 3],
  });
  const partial = builder.buildUnsafe();
  assert.ok(geocardErrors(partial).length > 0, "expected the card to be invalid");
  assert.throws(() => builder.build(), GeoCardValidationError);
});
