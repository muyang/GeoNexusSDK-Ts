/**
 * GeoMCP client tests.
 *
 * These replay the shared contract artefacts rather than inventing responses:
 * `contracts/mocks/*.json` are the canonical success payloads and
 * `contracts/mocks/errors/*.json` the canonical failures. If the Java side and
 * this SDK disagree, the mocks are where it shows up.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GEOMCP_METHODS,
  GeoMcpClient,
  GeoMcpClientError,
  GeoMcpError,
  GeoMcpErrorCode,
  JsonRpcErrorCode,
  WRITE_METHODS,
  advertisedSkills,
  type FetchLike,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, "..", "contracts");

function mock(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(contracts, relative), "utf8")) as Record<string, unknown>;
}

/**
 * Build a fetch stub that echoes the request id, so envelope checks pass and we
 * only exercise the payload under test.
 */
function echoFetch(payload: Record<string, unknown>, status = 200): FetchLike {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: string };
    const body =
      "jsonrpc" in payload
        ? { ...payload, id: request.id }
        : payload;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

function client(fetchFn: FetchLike): GeoMcpClient {
  return new GeoMcpClient({ baseUrl: "http://node.test", fetchFn });
}

test("method table and write methods match the protocol", () => {
  assert.deepEqual([...GEOMCP_METHODS], [
    "geo.capabilities",
    "geo.describe",
    "geo.execute",
    "geo.invoke",
    "geo.plan",
    "geo.health",
  ]);
  assert.deepEqual([...WRITE_METHODS], ["geo.execute", "geo.invoke"]);
  for (const readonly of ["geo.capabilities", "geo.describe", "geo.health", "geo.plan"]) {
    assert.ok(!WRITE_METHODS.has(readonly), `${readonly} must not be a write method`);
  }
});

test("error code ranges are disjoint, as JSON-RPC requires", () => {
  for (const code of Object.values(JsonRpcErrorCode)) {
    assert.ok(code < 0, `reserved code ${code} must be negative`);
  }
  for (const code of Object.values(GeoMcpErrorCode)) {
    assert.ok(code >= 2000 && code <= 2999, `application code ${code} must be in 2xxx`);
  }
});

test("capabilities parses the canonical mock", async () => {
  const c = client(echoFetch(mock("mocks/capabilities.json")));
  const caps = await c.capabilities();
  assert.ok("methods" in caps || "skills" in caps);
  assert.ok(Array.isArray(caps["skills"]), "capabilities should expose a skills list");
});

test("advertisedSkills handles string and object entries", () => {
  assert.deepEqual(advertisedSkills({ skills: ["a", { name: "b" }] }), ["a", "b"]);
  assert.deepEqual(advertisedSkills({}), []);
});

test("describe parses the canonical mock", async () => {
  const c = client(echoFetch(mock("mocks/describe.json")));
  const result = await c.describe({ skills: ["ndvi-analysis"] });
  assert.equal(typeof result, "object");
});

for (const name of ["skill-not-found", "geocard-not-found", "execution-failed", "invalid-argument", "contract-not-satisfied"]) {
  test(`surfaces "${name}" as a GeoMcpError with a 2xxx code`, async () => {
    const payload = mock(`mocks/errors/${name}.json`);
    const c = client(echoFetch(payload));
    await assert.rejects(
      () => c.execute({ skill: "x" }),
      (error: unknown) => {
        assert.ok(error instanceof GeoMcpError, `${name} should raise GeoMcpError`);
        const err = error as GeoMcpError;
        assert.ok(err.code >= 2000, `expected application code, got ${err.code}`);
        assert.ok(err.message.length > 0);
        assert.equal(err.isProtocolLevel, false);
        assert.notEqual(err.category, "unknown-application-error");
        return true;
      },
    );
  });
}

test("rejects a non-2.0 envelope", async () => {
  const c = client(echoFetch({ jsonrpc: "1.0", id: "x", result: {} }));
  await assert.rejects(() => c.health(), GeoMcpClientError);
});

test("rejects an id mismatch", async () => {
  const c = client(async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: "someone-else", result: {} }), {
      status: 200,
    }),
  );
  await assert.rejects(() => c.health(), (error: unknown) => {
    assert.ok(error instanceof GeoMcpClientError);
    assert.match((error as Error).message, /id mismatch/);
    return true;
  });
});

test("rejects a response with neither result nor error", async () => {
  const c = client(echoFetch({ jsonrpc: "2.0", id: "x" }));
  await assert.rejects(() => c.health(), (error: unknown) => {
    assert.match((error as Error).message, /neither result nor error/);
    return true;
  });
});

test("rejects a non-object result", async () => {
  const c = client(echoFetch({ jsonrpc: "2.0", id: "x", result: [1, 2] }));
  await assert.rejects(() => c.health(), (error: unknown) => {
    assert.match((error as Error).message, /must be an object/);
    return true;
  });
});

test("rejects a non-JSON body", async () => {
  const c = client(async () => new Response("<html>oops</html>", { status: 200 }));
  await assert.rejects(() => c.health(), (error: unknown) => {
    assert.match((error as Error).message, /not JSON/);
    return true;
  });
});

test("sends the API key only when configured", async () => {
  const seen: Array<Record<string, string>> = [];
  const fetchFn: FetchLike = async (_input, init) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    const request = JSON.parse(String(init?.body)) as { id: string };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
      status: 200,
    });
  };
  await new GeoMcpClient({ baseUrl: "http://n.test", apiKey: "secret", fetchFn }).health();
  await new GeoMcpClient({ baseUrl: "http://n.test", fetchFn }).health();
  assert.equal(seen[0]?.["x-api-key"], "secret");
  assert.equal(seen[1]?.["x-api-key"], undefined);
});

test("posts to /geomcp with a JSON-RPC body", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const fetchFn: FetchLike = async (input, init) => {
    url = input;
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body["id"], result: {} }), {
      status: 200,
    });
  };
  await new GeoMcpClient({ baseUrl: "http://node.test/", fetchFn }).health();
  assert.equal(url, "http://node.test/geomcp");
  assert.equal(body["jsonrpc"], "2.0");
  assert.equal(body["method"], "geo.health");
  assert.equal(typeof body["id"], "string");
});

test("transport failures become client errors, not crashes", async () => {
  const c = client(async () => {
    throw new Error("ECONNREFUSED");
  });
  await assert.rejects(() => c.health(), (error: unknown) => {
    assert.ok(error instanceof GeoMcpClientError);
    assert.match((error as Error).message, /transport error/);
    return true;
  });
});
