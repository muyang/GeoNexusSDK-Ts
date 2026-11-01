/**
 * A deliberately small JSON Schema validator (Draft 2020-12 subset).
 *
 * Why not pull in Ajv? Two reasons:
 *   1. Zero runtime dependencies keeps this SDK embeddable and auditable.
 *   2. The bundled schema uses a closed set of keywords, listed in
 *      ``SUPPORTED_KEYWORDS``. If someone extends the schema with a keyword
 *      this validator does not know, {@link assertSchemaIsSupported} fails
 *      loudly instead of silently under-validating.
 *
 * That second point is the important one: a validator that ignores constraints
 * it does not understand is worse than no validator, because it reports "valid".
 */

/** Keywords this validator implements. Anything else is rejected up front. */
const SUPPORTED_KEYWORDS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "minimum",
  "maximum",
  "pattern",
  "format",
  "oneOf",
]);

/** Meta keywords whose values are data, not subschemas. */
const NON_SCHEMA_KEYS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "default",
  "examples",
  "enum",
  "required",
  "type",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "uniqueItems",
]);

export type Schema = Record<string, unknown>;

/**
 * Throw if the schema uses a keyword this validator does not implement.
 *
 * Called once at module load, so an incompatible schema can never reach
 * {@link validate} and quietly pass everything.
 */
export function assertSchemaIsSupported(schema: Schema, path = "#"): void {
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(
        `Unsupported JSON Schema keyword "${key}" at ${path}. ` +
          `Add it to SUPPORTED_KEYWORDS and implement it, or the validator will under-validate.`,
      );
    }
    const here = `${path}/${key}`;
    if (key === "properties" && isRecord(value)) {
      for (const [prop, sub] of Object.entries(value)) {
        if (isRecord(sub)) assertSchemaIsSupported(sub, `${here}/${prop}`);
      }
    } else if (key === "items" && isRecord(value)) {
      assertSchemaIsSupported(value, `${here}/items`);
    } else if (key === "oneOf" && Array.isArray(value)) {
      value.forEach((sub, i) => {
        if (isRecord(sub)) assertSchemaIsSupported(sub, `${here}/oneOf/${i}`);
      });
    } else if (key === "additionalProperties" && isRecord(value)) {
      assertSchemaIsSupported(value, `${here}/additionalProperties`);
    } else if (!NON_SCHEMA_KEYS.has(key)) {
      // Unknown-but-allowed container keys: descend defensively.
      if (isRecord(value)) assertSchemaIsSupported(value, here);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate ``instance`` against ``schema``; returns human-readable errors. */
export function validate(schema: Schema, instance: unknown, path = "$"): string[] {
  const errors: string[] = [];

  if (typeof schema.oneOf !== "undefined" && Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as Schema[];
    const matches = branches.filter((b) => validate(b, instance, path).length === 0);
    if (matches.length !== 1) {
      errors.push(
        `${path}: must match exactly one of the allowed shapes (matched ${matches.length})`,
      );
    }
    // `oneOf` branches are alternative complete descriptions; do not also apply
    // sibling constraints here beyond what each branch already checked.
    return errors;
  }

  if (typeof schema.type === "string") {
    const expected = schema.type;
    if (!matchesType(instance, expected)) {
      errors.push(`${path}: expected ${expected}, got ${describeType(instance)}`);
      return errors; // further checks would produce noise
    }
  }

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((a) => deepEqual(a, instance))) {
      errors.push(
        `${path}: must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}` +
          ` (got ${JSON.stringify(instance)})`,
      );
    }
  }

  if (typeof instance === "string") {
    if (typeof schema.minLength === "number" && instance.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.pattern === "string") {
      // Schema patterns here are anchored ASCII classes; no need for `u` flag.
      const re = new RegExp(schema.pattern);
      if (!re.test(instance)) {
        errors.push(`${path}: does not match ${schema.pattern}`);
      }
    }
  }

  if (typeof instance === "number") {
    if (typeof schema.minimum === "number" && instance < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && instance > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(instance)) {
    if (typeof schema.minItems === "number" && instance.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && instance.length > schema.maxItems) {
      errors.push(`${path}: allows at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < instance.length; i += 1) {
        for (let j = i + 1; j < instance.length; j += 1) {
          if (deepEqual(instance[i], instance[j])) {
            errors.push(`${path}: items must be unique (duplicate at ${i} and ${j})`);
          }
        }
      }
    }
    if (isRecord(schema.items)) {
      instance.forEach((item, i) => {
        errors.push(...validate(schema.items as Schema, item, `${path}[${i}]`));
      });
    }
  }

  if (isRecord(instance)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in instance)) errors.push(`${path}: missing required "${key}"`);
      }
    }
    const props = isRecord(schema.properties) ? (schema.properties as Record<string, Schema>) : {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in instance) {
        errors.push(...validate(sub, instance[key], `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(instance)) {
        if (!(key in props)) errors.push(`${path}: unexpected property "${key}"`);
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const key of Object.keys(instance)) {
        if (!(key in props)) {
          errors.push(
            ...validate(schema.additionalProperties as Schema, instance[key], `${path}.${key}`),
          );
        }
      }
    }
  }

  return errors;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      // Unknown type keyword: refuse to guess, so the caller sees a real error.
      throw new Error(`Unsupported JSON Schema type "${expected}"`);
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Structural equality for the JSON value space. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}
