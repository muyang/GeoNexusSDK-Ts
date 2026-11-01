/**
 * Registry and OGE client tests.
 *
 * The OGE half encodes behaviour that was **measured against the live service**
 * (2026-10), so these tests are regression guards for facts, not preferences:
 *   - success code is 20000; 200 and 0 are failures
 *   - auth failures arrive as 40003
 *   - `pageNum` for catalog vs `pageNumber` for result search
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OGE_SUCCESS_CODES,
  OgeAuthError,
  OgeClient,
  OgeError,
  OgeExecutionError,
  RegistryClient,
  RegistryError,
  validateGeoCard,
  computeResourceCard,
  operatorCard,
  rasterProductCard,
  vectorProductCard,
  bboxFromCorners,
  type FetchLike,
} from "../dist/index.js";

const ENDPOINT = "http://oge.test/api";

/** fetch stub returning one JSON body and recording the request. */
function jsonFetch(
  payload: unknown,
  options: { status?: number; recorder?: (url: string, init: RequestInit | undefined, body: unknown) => void } = {},
): FetchLike {
  return async (input, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    options.recorder?.(input, init, body);
    return new Response(JSON.stringify(payload), {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function oge(fetchFn: FetchLike, extra: Partial<{ successCodes: number[] }> = {}): OgeClient {
  return new OgeClient({ endpoint: ENDPOINT, fetchFn, ...extra });
}

// ── Registry ────────────────────────────────────────────────────────────

test("registry register posts card and node_url", async () => {
  let captured: Record<string, unknown> = {};
  const fetchFn: FetchLike = async (_input, init) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ status: "registered" }), { status: 200 });
  };
  const card = validateGeoCard({
    geocard_version: "1.0",
    id: "asset-1",
    type: "data",
    name: "A",
    description: "d",
  });
  const client = new RegistryClient({ baseUrl: "http://reg.test", fetchFn });
  await client.register(card, "http://node:8787");
  assert.equal(captured["node_url"], "http://node:8787");
  assert.equal((captured["card"] as { id: string }).id, "asset-1");
});

test("registry search encodes filters into the query string", async () => {
  let url = "";
  const fetchFn: FetchLike = async (input) => {
    url = input;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  const client = new RegistryClient({ baseUrl: "http://reg.test", fetchFn });
  await client.search({
    capability: "ndvi",
    bbox: [100, 20, 110, 30],
    crs: "EPSG:4326",
    requiredBands: ["B4", "B5"],
    requiredResolution: 10,
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/search");
  assert.equal(parsed.searchParams.get("capability"), "ndvi");
  assert.equal(parsed.searchParams.get("bbox"), "100,20,110,30");
  assert.equal(parsed.searchParams.get("required_bands"), "B4,B5");
  assert.equal(parsed.searchParams.get("resolution"), "10");
});

test("registry surfaces HTTP errors with status and body", async () => {
  const client = new RegistryClient({
    baseUrl: "http://reg.test",
    fetchFn: async () => new Response(JSON.stringify({ detail: "nope" }), { status: 422 }),
  });
  await assert.rejects(() => client.getNodes(), (error: unknown) => {
    assert.ok(error instanceof RegistryError);
    assert.equal((error as RegistryError).status, 422);
    return true;
  });
});

test("registry listCards accepts {cards: []} shapes", async () => {
  const client = new RegistryClient({
    baseUrl: "http://reg.test",
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          cards: [{ card: { id: "a" }, node_url: "http://n" }],
        }),
        { status: 200 },
      ),
  });
  const cards = await client.listCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.node_url, "http://n");
});

// ── OGE: business codes ─────────────────────────────────────────────────

test("accepts the measured success code 20000", async () => {
  const client = oge(jsonFetch({ code: 20000, data: { records: [{ id: 1 }], pages: 3 } }));
  const page = await client.listDataProducts();
  assert.equal(page.items.length, 1);
  assert.equal(page.totalPages, 3);
});

test("200 and 0 are failures, not successes", async () => {
  for (const code of [200, 0]) {
    const client = oge(jsonFetch({ code, data: { fake: true } }));
    await assert.rejects(
      () => client.listDataProducts(),
      (error: unknown) => {
        assert.ok(error instanceof OgeError, `code ${code} should raise OgeError`);
        return true;
      },
      `code ${code} must be rejected`,
    );
  }
});

test("40003 maps to OgeAuthError", async () => {
  const client = oge(jsonFetch({ code: 40003, msg: "无效token" }));
  await assert.rejects(
    () => client.listDataProducts(),
    (error: unknown) => {
      assert.ok(error instanceof OgeAuthError);
      assert.match((error as Error).message, /40003/);
      return true;
    },
  );
});

test("HTTP 403 is an auth failure too", async () => {
  const client = oge(jsonFetch({}, { status: 403 }));
  await assert.rejects(() => client.listDataProducts(), OgeAuthError);
});

test("success codes are overridable but the default is the measured one", () => {
  assert.deepEqual([...OGE_SUCCESS_CODES], [20000]);
  const custom = new OgeClient({ endpoint: ENDPOINT, successCodes: [0] });
  assert.deepEqual([...custom.successCodes], [0]);
});

// ── OGE: request shapes ─────────────────────────────────────────────────

test("catalog request uses pageNum and the documented body", async () => {
  let body: Record<string, unknown> = {};
  let path = "";
  const client = oge(
    jsonFetch(
      { code: 20000, data: { records: [] } },
      {
        recorder: (url, _init, parsed) => {
          const u = new URL(url);
          path = u.pathname;
          body = parsed as Record<string, unknown>;
        },
      },
    ),
  );
  await client.listDataProducts({ dataType: 1, pageNum: 2, pageSize: 5, keywords: "land" });
  assert.equal(path, "/api/data-product/page");
  assert.equal(body["pageNum"], 2);
  assert.equal(body["pageSize"], 5);
  assert.equal(body["type"], 1);
  assert.equal(body["status"], 1);
  assert.equal(body["keywords"], "land");
});

test("result search uses pageNumber, not pageNum", async () => {
  let body: Record<string, unknown> = {};
  const client = oge(
    jsonFetch(
      { code: 20000, data: { records: [{ recordId: "job-1", taskName: "ndvi" }] } },
      { recorder: (_u, _i, parsed) => { body = parsed as Record<string, unknown>; } },
    ),
  );
  const results = await client.searchProcessResults({ pageNumber: 3, pageSize: 7, queryTaskName: "q" });
  assert.ok("pageNumber" in body);
  assert.ok(!("pageNum" in body));
  assert.equal(body["pageSize"], 7);
  assert.equal(results[0]?.taskId, "job-1");
  assert.equal(results[0]?.taskName, "ndvi");
});

test("images request uses pageNum", async () => {
  let query: URLSearchParams | undefined;
  const client = oge(
    jsonFetch({ code: 20000, data: { records: [] } }, {
      recorder: (url) => { query = new URL(url).searchParams; },
    }),
  );
  await client.listImages(634, { pageNum: 2, imageIdentification: "x" });
  assert.equal(query?.get("productId"), "634");
  assert.equal(query?.get("pageNum"), "2");
  assert.equal(query?.get("imageIdentification"), "x");
});

test("submitProcess sends {name, args} with a Bearer token", async () => {
  let body: Record<string, unknown> = {};
  let auth: string | undefined;
  const client = oge(
    jsonFetch({ code: 20000, data: { processId: "job-9" } }, {
      recorder: (_u, init, parsed) => {
        body = parsed as Record<string, unknown>;
        auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
      },
    }),
  );
  const result = await client.submitProcess("Coverage.NDVI", { coverage: "x", output: "y" }, "jwt-1");
  assert.equal(result.processId, "job-9");
  assert.equal(body["name"], "Coverage.NDVI");
  assert.deepEqual(body["args"], { coverage: "x", output: "y" });
  assert.equal(auth, "Bearer jwt-1");
});

test("submitProcess without a process id is an execution error", async () => {
  const client = oge(jsonFetch({ code: 20000, data: {} }));
  await assert.rejects(() => client.submitProcess("x", {}), OgeExecutionError);
});

test("process info refuses to run without tk", async () => {
  let called = false;
  const client = oge(jsonFetch({ code: 20000, data: {} }, { recorder: () => { called = true; } }));
  await assert.rejects(() => client.getProcessInfo("Coverage.NDVI"), OgeAuthError);
  assert.equal(called, false, "must not send an anonymous request");
});

// ── OGE: Coverage references and injection guards ───────────────────────

test("coverageRef matches the documented format", () => {
  assert.equal(
    OgeClient.coverageRef("LC08_L2SP_118039_20210107", "LC08_C02_L2"),
    "Platform:Coverage:LC08_L2SP_118039_20210107:LC08_C02_L2",
  );
});

test("coverageArg matches the documented shape", () => {
  assert.deepEqual(OgeClient.coverageArg("img", "prod"), {
    type: "Coverage",
    value: ["Platform:Coverage:img:prod"],
    pretreatment: false,
  });
});

test("coverageRef accepts real catalog names, including CJK and dots", () => {
  for (const [image, product] of [
    ["LC08_L2SP_118039_20210107_20210307_02_T2", "LC08_C02_L2"],
    ["n029e118", "蒙古SDG15.3.1"],
    ["img(1)", "prod-2"],
  ] as const) {
    assert.equal(OgeClient.coverageRef(image, product), `Platform:Coverage:${image}:${product}`);
  }
});

test("coverageRef rejects injection characters", () => {
  for (const bad of ["a b", "a/../../etc", 'a"b', "a;b", "a'b", "a\nb"]) {
    assert.throws(() => OgeClient.coverageRef(bad, "prod"), /disallowed characters/);
  }
});

test("coverageRef rejects colons and empty segments", () => {
  assert.throws(() => OgeClient.coverageRef("a:b", "prod"), /must not contain ':'/);
  assert.throws(() => OgeClient.coverageRef("", "prod"));
  assert.throws(() => OgeClient.coverageRef("img", ""));
});

test("getCogUrl rejects path and query injection", () => {
  const client = new OgeClient({ endpoint: ENDPOINT });
  for (const bad of ["../etc/passwd", "a?x=1", "a#f", "a b", "a%2e", ""]) {
    assert.throws(() => client.getCogUrl(bad));
  }
  assert.equal(client.getCogUrl("job-abc-123"), `${ENDPOINT}/computation-api/styles/cog/job-abc-123`);
});

// ── OGE: preview ────────────────────────────────────────────────────────

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("preview returns PNG bytes and sends imageId", async () => {
  let query = "";
  const client = new OgeClient({
    endpoint: ENDPOINT,
    fetchFn: async (input) => {
      query = new URL(input).searchParams.get("imageId") ?? "";
      return new Response(PNG, { status: 200 });
    },
  });
  const bytes = await client.getImagePreview(144);
  assert.equal(query, "144");
  assert.equal(bytes[0], 0x89);
});

test("preview rejects non-PNG payloads", async () => {
  const client = new OgeClient({
    endpoint: ENDPOINT,
    fetchFn: async () => new Response("<html>not an image</html>", { status: 200 }),
  });
  await assert.rejects(() => client.getImagePreview(144), /PNG/);
});

test("preview enforces the size cap", async () => {
  const big = new Uint8Array(PNG.length + 4096);
  big.set(PNG);
  const client = new OgeClient({
    endpoint: ENDPOINT,
    maxPreviewBytes: 1024,
    fetchFn: async () => new Response(big, { status: 200 }),
  });
  await assert.rejects(() => client.getImagePreview(144), /exceeds/);
});

test("preview validates imageId", async () => {
  const client = new OgeClient({ endpoint: ENDPOINT });
  for (const bad of [0, -3, "abc"]) {
    await assert.rejects(() => client.getImagePreview(bad), /positive integer/);
  }
});

// ── OGE: card builders ──────────────────────────────────────────────────

test("raster card derives bbox from real corner fields", () => {
  const { card, warnings } = rasterProductCard(
    { id: 634, name: "China Coastal Land Cover" },
    {
      endpoint: ENDPOINT,
      licenseName: "OGE-Terms",
      image: {
        imageIdentification: "classifiedv001_PO_v20211206",
        upperLeftLat: 41.1388,
        upperLeftLong: 107.9135,
        upperRightLat: 41.1388,
        upperRightLong: 112.099,
        lowerLeftLat: 36.9534,
        lowerLeftLong: 107.9135,
        lowerRightLat: 36.9534,
        lowerRightLong: 112.099,
      },
    },
  );
  validateGeoCard(card);
  assert.deepEqual(card.spatial?.bbox, [107.9135, 36.9534, 112.099, 41.1388]);
  assert.equal(card.spatial?.crs, "EPSG:4326");
  assert.deepEqual(warnings, []);
});

test("raster card stays honest when no extent is available", () => {
  const { card, warnings } = rasterProductCard({ id: 1, name: "x" }, { endpoint: ENDPOINT });
  assert.equal(card.spatial, undefined);
  assert.ok(warnings.some((w) => /spatial/.test(w)));
  assert.ok(warnings.some((w) => /license/i.test(w)));
});

test("vector card uses the real min/max scalars", () => {
  const { card, warnings } = vectorProductCard(
    {
      id: 599,
      name: "open-feature",
      tableName: "oge_vector_shuixi_polygon",
      minLon: 73.259,
      minLat: 16.5240871,
      maxLon: 135.097507,
      maxLat: 53.5630977,
    },
    { endpoint: ENDPOINT, licenseName: "OGE-Terms" },
  );
  validateGeoCard(card);
  assert.deepEqual(card.spatial?.bbox, [73.259, 16.524087, 135.097507, 53.563098]);
  assert.deepEqual(warnings, []);
});

test("vector card admits a null tableName instead of inventing one", () => {
  const { card, warnings } = vectorProductCard(
    { id: 619, name: "mongolia_national", tableName: null },
    { endpoint: ENDPOINT, licenseName: "OGE-Terms" },
  );
  assert.equal(card.spatial, undefined);
  assert.ok(warnings.some((w) => /tableName/.test(w)));
});

test("bboxFromCorners ignores projected coordinates", () => {
  assert.equal(
    bboxFromCorners({
      upperLeftLong: 500000,
      upperLeftLat: 4000000,
      lowerRightLong: 600000,
      lowerRightLat: 3900000,
    }),
    undefined,
  );
});

test("bboxFromCorners handles antimeridian ordering", () => {
  assert.deepEqual(
    bboxFromCorners({
      upperLeftLong: 179,
      upperLeftLat: 10,
      lowerRightLong: -179,
      lowerRightLat: -10,
    }),
    [-179, -10, 179, 10],
  );
});

test("operator card is a skill card with schema and capabilities", () => {
  const { card, warnings } = operatorCard("Coverage.NDVI", {
    endpoint: ENDPOINT,
    licenseName: "OGE-Terms",
    capabilities: ["ndvi"],
    inputs: [
      { name: "coverage", type: "Coverage" },
      { name: "redBandName", type: "string" },
    ],
  });
  validateGeoCard(card);
  assert.equal(card.type, "skill");
  assert.deepEqual(card.capabilities, [{ name: "ndvi" }]);
  assert.equal((card.interface as { type: string }).type, "oge-process");
  const schema = (card["x-geonexus"] as { input_schema: { required: string[] } }).input_schema;
  assert.deepEqual(schema.required, ["coverage", "redBandName"]);
  assert.deepEqual(warnings, []);
});

test("operator card without a definition warns and omits schemas", () => {
  const { card, warnings } = operatorCard("Coverage.NDVI", { endpoint: ENDPOINT });
  assert.equal((card["x-geonexus"] as Record<string, unknown>)["input_schema"], undefined);
  assert.ok(warnings.some((w) => /input_schema/.test(w)));
  assert.ok(warnings.some((w) => /capability/i.test(w)));
});

test("operator card flags a colon in the operator name", () => {
  const { warnings } = operatorCard("Platform:Coverage:img:prod", { endpoint: ENDPOINT });
  assert.ok(warnings.some((w) => w.includes(":")));
});

test("compute card never invents specs", () => {
  const { card, warnings } = computeResourceCard({ endpoint: ENDPOINT });
  validateGeoCard(card);
  assert.equal(card.runtime, undefined);
  assert.equal(card.provides, undefined);
  assert.ok(warnings.some((w) => /specs/.test(w)));
  assert.ok(warnings.some((w) => /operator list/.test(w)));
});

test("compute card records declared specs and dedupes operators", () => {
  const { card, warnings } = computeResourceCard({
    endpoint: ENDPOINT,
    name: "oge-compute",
    cpu: 8,
    memory: "32Gi",
    gpu: "none",
    operators: ["Coverage.NDVI", "Coverage.NDVI", "Coverage.NDWI"],
    licenseName: "OGE-Terms",
  });
  validateGeoCard(card);
  assert.deepEqual(card.runtime, { cpu: 8, memory: "32Gi", gpu: "none" });
  assert.deepEqual(card.provides, ["Coverage.NDVI", "Coverage.NDWI"]);
  assert.deepEqual(warnings, []);
});

test("card ids are ascii and unique across endpoints", () => {
  const a = rasterProductCard({ id: 1, name: "蒙古SDG" }, { endpoint: ENDPOINT }).card;
  const b = rasterProductCard({ id: 1, name: "蒙古SDG" }, { endpoint: "http://other/api" }).card;
  assert.notEqual(a.id, b.id);
  for (const card of [a, b]) {
    assert.match(card.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    validateGeoCard(card);
  }
});
