/** Library entry point: what other horde packages use (board briefs, verify's related tests). */
export { type ContextSettings, loadContextSettings, openProject, type Project, readText, relPath, select } from "./files.js"
export { fileInfo, type Graph, importGraph, type TestLink, testsFor } from "./graph.js"
export { type Definition, type DefKind, definitions, importSpecs, type Lang, langOf } from "./lang.js"
export { entryPoints, projectMap } from "./map.js"
export { goalTerms, type PackOptions, pack } from "./pack.js"
export {
  type ExcerptOptions,
  excerpt,
  type FindKind,
  type FindOptions,
  find,
  type Hit,
  numbered,
  outline,
  queryRegex,
  type SymbolInfo,
  symbol,
} from "./search.js"
