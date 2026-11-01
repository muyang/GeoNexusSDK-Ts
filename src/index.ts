/**
 * GeoNexus SDK for TypeScript (v1.1.1 parity).
 *
 * Scope mirrors the Python *core* — the layers that "know only cards and the
 * protocol", with no platform-specific knowledge inside them:
 *
 *   geocard   — the contract: types, schema validation, builder
 *   geomcp    — the protocol: JSON-RPC envelope, methods, error codes, client
 *   registry  — discovery: register, search, review, nodes
 *   oge       — one adapter, kept at the edge (extends the core, never inside it)
 *
 * Anything a language binding cannot express (Pydantic quirks, Python-only
 * helpers) is intentionally absent rather than faked.
 */

export {
  GeoCardValidationError,
  GeoMcpError,
  GeoMcpErrorCode,
  JsonRpcErrorCode,
  OgeAuthError,
  OgeError,
  OgeExecutionError,
  RegistryError,
  type GeoMcpErrorCodeValue,
  type JsonRpcErrorCodeValue,
} from "./errors.js";

export {
  GEOCARD_TYPES,
  GeoCardBuilder,
  capabilityNames,
  geocardErrors,
  parseGeoCard,
  validateGeoCard,
  type AccessSection,
  type Capability,
  type ComplianceSection,
  type GeoCard,
  type GeoCardType,
  type ProvenanceSection,
  type RuntimeSection,
  type SpatialSection,
} from "./geocard.js";

export {
  GEOMCP_METHODS,
  GeoMcpClient,
  GeoMcpClientError,
  WRITE_METHODS,
  advertisedSkills,
  buildRequest,
  makeRequestId,
  type DescribeParams,
  type ExecuteParams,
  type GeoMcpClientOptions,
  type GeoMcpMethod,
  type JsonRpcErrorBody,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PlanParams,
  type SpatialContext,
  type TemporalContext,
} from "./geomcp.js";

export {
  RegistryClient,
  type RegisterOptions,
  type RegistryClientOptions,
  type RegistryEntry,
  type SearchQuery,
  type SearchResult,
} from "./registry.js";

export {
  OGE_API_BASE,
  OGE_AUTH_ERROR_CODES,
  OGE_SITE_URL,
  OGE_SUCCESS_CODES,
  OGE_TEST_API_BASE,
  OGE_TEST_SITE_URL,
  OgeClient,
  type OgeCatalogPage,
  type OgeClientOptions,
  type OgeProcessResult,
} from "./oge.js";

export {
  bboxFrom,
  bboxFromCorners,
  checkedCard,
  computeResourceCard,
  operatorCard,
  paramsToSchema,
  rasterProductCard,
  vectorProductCard,
  type CardBuildResult,
  type ComputeCardOptions,
  type OperatorCardOptions,
  type RasterCardOptions,
  type VectorCardOptions,
} from "./oge_cards.js";
