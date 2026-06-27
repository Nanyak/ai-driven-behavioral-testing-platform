/**
 * Code-derived schema source: resolves a `@medusajs/types` HTTP response type
 * (e.g. `StoreCartResponse`) into a flat `SchemaNode`, using the TypeScript
 * compiler API over the package's shipped `.d.ts` declarations.
 *
 * Why this exists: Medusa's PUBLISHED OpenAPI (the api-reference webpage) is
 * fetched from `develop` and drifts from the pinned 2.15.5 runtime — and it
 * mislabels optionality/nullability (e.g. `StoreProduct.hs_code` is marked
 * required-non-null but the runtime returns null). The installed
 * `@medusajs/types` package is VERSION-MATCHED (2.15.5) and carries accurate
 * `?` (optional) and `| null` (nullable) markers, so it is a far better oracle
 * source. Faithful mapping: optional OR nullable -> "ignored" (the comparator
 * skips it both ways); arrays -> opaque "array" leaf (matches the observed
 * `describe()` model); nested interfaces -> recurse; enums/literals -> their
 * primitive. Residual types-vs-runtime gaps are reconciled by the observed
 * overlay in buildGolden (see the 2026-06-27 OAS-drift investigation).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import ts from "typescript";
import type { SchemaNode } from "../types.js";

export interface TypesExtractor {
  /** Resolve an exported type name to a flat SchemaNode, or null if absent. */
  resolve(typeName: string): SchemaNode | null;
  /** Version of the installed @medusajs/types package (the spec provenance). */
  version: string;
  /** Absolute path to the resolved .d.ts entry (for provenance/debugging). */
  dtsEntry: string;
}

const MAX_DEPTH = 10;

function primitiveLeaf(checker: ts.TypeChecker, t: ts.Type): SchemaNode | null {
  const f = t.flags;
  if (f & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) return "string";
  if (f & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) return "number";
  if (f & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return "boolean";
  if (f & ts.TypeFlags.EnumLike) return "string";
  // A union of string/number literals (a TS enum-like) collapses to its base.
  if (t.isUnion()) {
    const real = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    if (real.length > 0 && real.every((x) => x.flags & ts.TypeFlags.StringLiteral)) return "string";
    if (real.length > 0 && real.every((x) => x.flags & ts.TypeFlags.NumberLiteral)) return "number";
  }
  return null;
}

function isNullableType(t: ts.Type): boolean {
  if (t.isUnion()) return t.types.some((x) => x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined));
  return !!(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined));
}

function nonNull(t: ts.Type): ts.Type {
  if (t.isUnion()) {
    const real = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    return real.length === 1 ? real[0] : (real[0] ?? t);
  }
  return t;
}

export function createTypesExtractor(backendDir: string): TypesExtractor {
  const require = createRequire(`${backendDir.replace(/\/?$/, "/")}noop.js`);
  const pkgPath = require.resolve("@medusajs/types/package.json");
  const version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  const dtsEntry = require.resolve("@medusajs/types").replace(/\.js$/, ".d.ts");

  const program = ts.createProgram([dtsEntry], {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    skipLibCheck: true,
    noEmit: true,
    // REQUIRED: without strictNullChecks, TS absorbs `null` into unions, so a
    // `string | null` field would collapse to `string` and we'd lose the
    // nullability signal that is the whole point of reading the types.
    strict: true,
    baseUrl: dirname(pkgPath),
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(dtsEntry);
  if (!sf) throw new Error(`could not load @medusajs/types entry: ${dtsEntry}`);
  const moduleSym = checker.getSymbolAtLocation(sf);
  const exportsByName = new Map<string, ts.Symbol>();
  if (moduleSym) {
    for (const s of checker.getExportsOfModule(moduleSym)) exportsByName.set(s.getName(), s);
  }

  function toSchema(type: ts.Type, depth: number, seen: Set<string>): SchemaNode {
    if (depth > MAX_DEPTH) return "object";
    const t = nonNull(type);
    if (checker.isArrayType(t) || checker.isTupleType(t)) return "array";
    const prim = primitiveLeaf(checker, t);
    if (prim) return prim;
    const props = checker.getPropertiesOfType(t);
    if (props.length === 0) return "object";
    const id = checker.typeToString(t);
    if (seen.has(id)) return "object"; // break cycles (region -> products -> region)
    const next = new Set(seen).add(id);
    const node: { [key: string]: SchemaNode } = {};
    for (const p of props) {
      const decl = p.valueDeclaration ?? p.declarations?.[0] ?? sf!;
      const pt = checker.getTypeOfSymbolAtLocation(p, decl);
      const optional = !!(p.flags & ts.SymbolFlags.Optional);
      // Faithful: a field that is optional (`?`) OR nullable (`| null`) is not
      // guaranteed in a conforming response, so it is "ignored" (the comparator
      // skips it in both directions — no false missing_field / type_changed).
      node[p.getName()] = optional || isNullableType(pt) ? "ignored" : toSchema(pt, depth + 1, next);
    }
    return node;
  }

  return {
    version,
    dtsEntry,
    resolve(typeName: string): SchemaNode | null {
      const sym = exportsByName.get(typeName);
      if (!sym) return null;
      return toSchema(checker.getDeclaredTypeOfSymbol(sym), 0, new Set());
    },
  };
}
