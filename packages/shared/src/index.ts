export const SCHEMA_VERSION = "0.1.0";

export * from "./envelope.js";

export * from "./namespace.js";

export * from "./api.js";

// The spec-centric convenience helpers are not included in `export *` from
// the envelope module because they're convenient aliases (lowercase schema
// names); declare them explicitly. Everything else from `api.js` (SpecQuestion,
// SpecDraft, ThreadStatus, PatchSpecBody, Thread) already flows through the
// wildcard re-export above.
// (Currently a no-op placeholder — the aliases live in `envelope.ts` and are
// picked up by `export * from "./envelope.js"`.)
