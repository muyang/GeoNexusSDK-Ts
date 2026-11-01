<!--
This repository is generated from the GeoNexus monorepo (muyang/GeoNexus-SDK),
subdirectory `sdk-ts/`, at commit 21c6af7. Edits made here must be carried back to
the monorepo, otherwise the two diverge silently.

The vendored contract files (`schemas/`, `contracts/mocks/`) come from the same
upstream commit and are checked by tests; refresh them with
`./scripts/sync-contracts.sh /path/to/GeoNexus-SDK`.
-->

# GeoNexus SDK for TypeScript

TypeScript 客户端，与 **GeoNexus-SDK v1.1.1（Python）内核对齐**。
零运行时依赖（Node ≥ 20 自带 `fetch`），可直接嵌入 Node 服务或边缘函数。

## 这层 SDK 覆盖什么

严格对应 Python SDK 的**内核**——只认识"卡片 + 协议"的那几层：

| 模块 | 职责 | 对应 Python |
|---|---|---|
| `geocard` | 卡片类型、契约校验、构建器 | `geonexus.geocard` |
| `geomcp` | JSON-RPC 信封、方法表、错误码、客户端 | `geonexus.geomcp.client` |
| `registry` | 注册、检索、审核、节点发现 | `geonexus.registry.client` |
| `oge` | OGE 适配（数据/算子/算力/预览） | `geonexus.adapters.oge_*` |

**不包含**的部分是刻意留白的，而不是忘了做：Agent 规划、任务图状态机、
配方引擎、GAAG、联邦下推、Python 服务端实现——这些要么是 Python 生态专属
（例如依赖 `pydantic` 的行为），要么在 TypeScript 里没有对等物。
硬凑一份"看起来全"的 API 只会让两边行为不一致。

## 安装

```bash
npm install @geonexus/sdk
```

本仓库内开发：

```bash
npm install --cache ./.npm-cache   # 缓存放工作区内，避免污染全局
npm test                            # 编译 + 跑 70 项测试
```

## 快速开始

```ts
import { GeoMcpClient, RegistryClient, validateGeoCard } from "@geonexus/sdk";

// 1. 问节点能做什么
const node = new GeoMcpClient({ baseUrl: "http://127.0.0.1:8787" });
const caps = await node.capabilities();

// 2. 执行一个技能
const result = await node.execute({
  skill: "oge-ndvi",
  params: { coverage: "Platform:Coverage:<影像>:<产品>", output: "ndvi_1" },
});

// 3. 让卡片可被发现
const registry = new RegistryClient({ baseUrl: "http://127.0.0.1:8790" });
await registry.register(validateGeoCard(card), "http://127.0.0.1:8787");
const hits = await registry.search({ capability: "ndvi" });
```

## GeoCard 校验：严格与宽松是分开的两层

```ts
import { geocardErrors, parseGeoCard, validateGeoCard } from "@geonexus/sdk";

geocardErrors(card);      // string[]：列出**全部**违规，不是只报第一条
validateGeoCard(card);    // 违规就抛 GeoCardValidationError
parseGeoCard(card);       // 只做结构解析，不查契约——用来检视别人给的坏卡
```

这一点和 Python 侧一致（`load_geocard(validate=False)` 也允许读入畸形卡片）。
把两者合成一个函数会导致"想看一眼坏卡"都做不到。

### 契约来源：同一份 schema

`sdk-ts/src/geocard.schema.json` 是仓库根 `schemas/geocard.schema.json` 的
**逐字节副本**，并由测试断言两者相同：

```ts
test("bundled schema is identical to the repository schema", ...)
```

三个 SDK 加 Java 侧都对着这一份文件校验，所以"TS 认为合法、Python 认为非法"
这种事在 CI 就会暴露，而不是等到联调。

校验器本身是**手写的 JSON Schema 子集实现**（`src/jsonschema.ts`），只支持
schema 实际用到的关键字。若有人给 schema 加了本实现不认识的关键字，
模块加载时就会抛错——**宁可启动失败，也不静默放行**，因为忽略约束的校验器
比没有校验器更危险（它会回报 valid）。

## OGE 客户端：按实测行为实现

```ts
import { OgeClient } from "@geonexus/sdk";

const oge = new OgeClient({ endpoint: "http://47.107.61.86/api" });
const page = await oge.listDataProducts({ dataType: 0, pageSize: 10 });
const png = await oge.getImagePreview(3538826); // 8 位展示预览，非原始像元
```

几条**实测确认**、且与直觉相反的行为，已在测试中锁定：

| 行为 | 说明 |
|---|---|
| 成功码是 `20000` | `200` 和 `0` 在本服务是**失败**码，当成成功会掩盖真实错误 |
| 鉴权失败是 `40003` | 也可能表现为 HTTP 401/403，统一映射为 `OgeAuthError` |
| 目录分页用 `pageNum` | 但结果检索用 `pageNumber`——两套历史命名，统一即 400 |
| `process/info` 非匿名 | 无 `tk` 时本地直接报错，不发注定失败的请求 |
| 影像范围是四角经纬度 | `upperLeftLat/Long` 等，不是 `bbox` |
| 矢量范围是独立标量 | `minLon`/`minLat`/`maxLon`/`maxLat` |

两个站点**不是同一套数据**（生产站 48 个产品 / 测试站 34 个），所以卡片要
记录实际用的地址：

```ts
import { OGE_API_BASE, OGE_TEST_API_BASE } from "@geonexus/sdk";
```

### 注入防护

Coverage 引用会被拼进 OGE 后端查询，所以每段走字符白名单（字母、数字、
下划线、点、括号、连字符、中日韩汉字）。空格、引号、斜杠、分号一律拒绝。
`getCogUrl()` 同样拒绝含 `../`、`?`、`#` 的 `processId`。

真实目录名都能通过：

```ts
OgeClient.coverageRef("n029e118", "蒙古SDG15.3.1");
// → "Platform:Coverage:n029e118:蒙古SDG15.3.1"
```

## OGE 资产 → GeoCard

```ts
import { rasterProductCard, operatorCard, computeResourceCard, checkedCard } from "@geonexus/sdk";

const { card, warnings } = rasterProductCard(product, {
  endpoint: OGE_TEST_API_BASE,
  image,                       // 传了就用首景标识与四角范围
  licenseName: "OGE-Terms",   // 许可只能人工给
});
checkedCard({ card, warnings }); // 校验通过才返回
```

每个构建函数都返回 `{ card, warnings }`。`warnings` 说明**哪些事实没拿到**：

- 没有空间范围 → 卡片不带 `spatial`，并且**不会**编一个 bbox
- 没给 `licenseName` → 只告警，不替你决定数据能不能这么用
- 算力没给规格 → `runtime` 整个字段都不写

最后一条尤其重要：空字段让调度器知道"未知"，而猜一个 `cpu: 4` 会让它以为
"四核可用"，然后把任务调度到跑不动的机器上。**空比错安全。**

## 错误处理

```ts
import { GeoMcpError, GeoMcpErrorCode, OgeAuthError } from "@geonexus/sdk";

try {
  await node.execute({ skill: "oge-ndvi" });
} catch (error) {
  if (error instanceof GeoMcpError) {
    if (error.code === GeoMcpErrorCode.SkillNotFound) { /* 技能不存在 */ }
    if (error.isProtocolLevel) { /* 负数 = JSON-RPC 协议层 */ }
    console.log(error.category); // "skill-not-found" / "protocol" / ...
  }
}
```

错误码分两段且不相交，测试会断言这一点：

- **负数**：JSON-RPC 2.0 保留码（`-32700` / `-32600` / `-32601` / `-32602` / `-32603`），不可自造
- **2xxx**：GeoNexus 应用码（`2000` 合约不满足 … `2009` 联邦不可解析）

混淆两者会让客户端无法区分"协议层失败"与"业务拒绝"，重试策略就会出错。

## 测试

```bash
npm test
```

70 项，分三组：

- `test/geocard.test.ts` — 契约、schema 一致性、严格/宽松分层
- `test/geomcp.test.ts` — 信封语义，**直接复用 `contracts/mocks/` 的共享样本**
- `test/oge.test.ts` — 实测行为、注入防护、转卡不编造

`geomcp` 那组读取仓库根 `contracts/mocks/*.json`（含 `errors/`）。那是 Java 侧
也在用的标准响应，所以"TS 解析不了 Java 的响应"这类问题会在这里失败。

## 与 Python 的已知差异

| 项 | Python | TypeScript | 原因 |
|---|---|---|---|
| `type` 枚举 | 模型宽松、校验器强制 | 同样分层 | 有意保留"检视坏卡"能力 |
| 哈希后缀 | `sha256[:8]` | FNV-1a（8 hex） | 避免为一次哈希引入依赖；**跨语言 id 不保证相同** |
| 服务端 | 完整实现 | 不提供 | 见文首"这层 SDK 覆盖什么" |

如果确实需要跨语言一致的卡片 id，应当显式传入 `id`，而不是依赖自动生成。
