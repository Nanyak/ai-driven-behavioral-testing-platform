/**
 * Minimal OpenAPI 3 document types — only the subset this project's tooling
 * touches (paths, operations, responses, `$ref` schemas). Not a full OpenAPI
 * type library; deliberately narrow so `oas-source.ts` and `build-oas.ts`
 * share one typed contract for the base/augmented spec shape.
 *
 * The REAL bundled Medusa spec (post-Redocly-bundle, all `$ref`s internal)
 * uses two shapes this minimal fixture-era model didn't need to cover:
 *  - **Response-level `$ref`** (`responses.401: { $ref: "#/components/responses/unauthorized" }`)
 *    — Medusa shares common error responses via `components/responses/*`,
 *    not inline per-operation. `OasResponse` is therefore a union of an
 *    inline response and a `$ref` to one.
 *  - **`allOf` schema composition** (e.g. `StoreProductListResponse` is a
 *    pagination-envelope fragment `allOf` a `products` fragment) — used by
 *    Medusa's generator to compose shared "paginated list" shapes.
 */

export interface OasRefSchema {
  $ref: string;
}

export interface OasInlineSchema {
  type?: string | string[];
  properties?: Record<string, OasSchema>;
  items?: OasSchema;
  required?: string[];
  oneOf?: OasSchema[];
  allOf?: OasSchema[];
  description?: string;
  // Spec-authored VALUE constraints (Tier A value-level golden). Lifted into
  // a golden's `value_rules` by `value/value-rules.ts`; the spec is the author,
  // so these are deterministic and zero-judgement (ADR 0001).
  enum?: (string | number | boolean)[];
  const?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  format?: string;
}

export type OasSchema = OasRefSchema | OasInlineSchema;

export interface OasMediaType {
  schema: OasSchema;
}

export interface OasInlineResponse {
  description: string;
  content?: Record<string, OasMediaType>;
}

/** A response component is itself `$ref`-able (`components/responses/*`). */
export type OasResponse = OasInlineResponse | OasRefSchema;

export interface OasOperation {
  operationId: string;
  summary?: string;
  responses: Record<string, OasResponse>;
}

export type OasMethod = "get" | "post" | "patch" | "put" | "delete";

export type OasPathItem = Partial<Record<OasMethod, OasOperation>>;

export interface OasDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, OasPathItem>;
  components: {
    schemas: Record<string, OasInlineSchema>;
    responses?: Record<string, OasInlineResponse>;
  };
}

export function isRefSchema(schema: OasSchema): schema is OasRefSchema {
  return typeof (schema as OasRefSchema).$ref === "string";
}

export function isRefResponse(response: OasResponse): response is OasRefSchema {
  return typeof (response as OasRefSchema).$ref === "string";
}
