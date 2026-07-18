// scripts/_hybrid-test-env.ts
//
// The isolated test collection for the hybrid smoke test. The collection
// name is set via the QMS_QDRANT_COLLECTION_OVERRIDE env var in the npm
// script (package.json "integration:hybrid"), which guarantees it is in the
// environment BEFORE any module - including config.ts - is evaluated.
// That sidesteps ESM import-order fragility entirely.
//
// This module just reads it back so the test can reference and clean it up.

export const TEST_COLLECTION =
  process.env.QMS_QDRANT_COLLECTION_OVERRIDE ?? "qms_hybrid_smoke_test";