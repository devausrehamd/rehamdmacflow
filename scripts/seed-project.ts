// scripts/seed-project.ts
//
// Populate Redis with example project facts, standing decisions,
// and lessons. Useful for:
//   - Bootstrapping a fresh environment with realistic test data
//   - Demonstrating the memory system without waiting to accumulate
//     real data through human reviews
//   - Resetting to a known state during development
//
// The seed data here is fictional - representative of what the
// real system would accumulate, but invented for the demo.
//
// Usage:
//   npm run seed                      # seed defaults
//   npm run seed -- --clear           # clear existing seed data first
//   npm run seed -- --project FALCON  # seed only one project

import { redis } from "../src/clients.js";

const args = process.argv.slice(2);
const CLEAR_FIRST = args.includes("--clear");
const PROJECT_FILTER = (() => {
  const i = args.indexOf("--project");
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

// ---------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------

const projectFacts = {
  "FALCON-FW-2.4": {
    lead_engineer: { value: "A. Singh", set_at: "2026-03-01" },
    risk_file: { value: "RMF-2026-008", set_at: "2026-03-01" },
    safety_class: { value: "Class B", set_at: "2026-03-01", justification: "Hazard analysis identified moderate harm potential from misclassified obstacles." },
    target_release: { value: "Q3 2026", set_at: "2026-03-01" },
    related_sops: { value: ["QMS-SOP-001", "QMS-SOP-012"], set_at: "2026-03-15" },
  },
  "BEACON-HW-1.2": {
    lead_engineer: { value: "M. Patel", set_at: "2026-02-15" },
    risk_file: { value: "RMF-2026-004", set_at: "2026-02-15" },
    safety_class: { value: "Class B", set_at: "2026-02-15" },
    target_release: { value: "Q2 2026", set_at: "2026-02-15" },
  },
  "SCAN-FW-3.0": {
    lead_engineer: { value: "T. Chen", set_at: "2026-01-20" },
    risk_file: { value: "RMF-2025-021", set_at: "2026-01-20" },
    safety_class: { value: "Class A", set_at: "2026-01-20", justification: "Diagnostic-only; cannot influence beacon output." },
    target_release: { value: "Q4 2026", set_at: "2026-01-20" },
  },
};

const standingDecisions = [
  {
    key: "qms:decisions:global:reference-style",
    value: {
      scope: "all_documents",
      decision: "References to IEC 62304 use the full form 'IEC 62304:2006+A1:2015 §X.Y' on first mention and the abbreviated form '§X.Y' thereafter.",
      established_by: "QA Director",
      established_at: "2026-01-15",
      status: "active",
    },
  },
  {
    key: "qms:decisions:class-b:lifecycle-model",
    value: {
      scope: "all_class_b_documents",
      decision: "Class B firmware uses an iterative V-model with formal design reviews at requirements, architecture, and integration gates.",
      established_by: "Engineering Director",
      established_at: "2026-02-01",
      status: "active",
    },
  },
  {
    key: "qms:decisions:class-a:lifecycle-model",
    value: {
      scope: "all_class_a_documents",
      decision: "Class A software may use a simplified waterfall lifecycle with combined design review and a single verification gate.",
      established_by: "Engineering Director",
      established_at: "2026-02-01",
      status: "active",
    },
  },
  {
    key: "qms:decisions:global:traceability-format",
    value: {
      scope: "all_documents",
      decision: "Traceability matrices are produced as markdown tables with columns: Requirement ID, Description, Design Element, Test Case ID, Status.",
      established_by: "QA Lead",
      established_at: "2026-02-20",
      status: "active",
    },
  },
];

const lessons = [
  {
    docType: "sdp",
    payload: {
      context_snippet: "Class B firmware development plan",
      lesson: "Always reference the specific risk management file by ID in the Risk Management section, not just the generic risk process.",
      issue: "Multiple SDPs were rejected for referring to 'the risk management process' without identifying the project's RMF.",
      source_doc_id: "QMS-SOP-001",
      source_doc_version: "v3.2",
      reviewer: "QA Director",
      status: "active",
      created_at: "2026-04-12T10:24:00Z",
    },
  },
  {
    docType: "sdp",
    payload: {
      context_snippet: "Verification strategy section",
      lesson: "Verification strategy must specify test types (unit, integration, system, regression) with quantified coverage targets, not just 'comprehensive testing'.",
      issue: "Reviewers repeatedly flagged generic verification language as insufficient.",
      source_doc_id: "QMS-SOP-001",
      source_doc_version: "v3.2",
      reviewer: "Verification Lead",
      status: "active",
      created_at: "2026-04-18T14:10:00Z",
    },
  },
  {
    docType: "svp",
    payload: {
      context_snippet: "Software Verification Plan deliverables",
      lesson: "Each test case in the SVP must trace to at least one requirement ID. Untraceable test cases are non-compliant.",
      issue: "An SVP draft contained test cases without traceability links and was rejected at first review.",
      source_doc_id: "QMS-SOP-012",
      source_doc_version: "v2.1",
      reviewer: "QA Director",
      status: "active",
      created_at: "2026-05-02T09:00:00Z",
    },
  },
  {
    docType: "risk",
    payload: {
      context_snippet: "Risk analysis severity scoring",
      lesson: "Severity ratings of '5 - Catastrophic' require an explicit citation to a referenced hazard or historical incident; ratings without justification are downgraded by reviewers.",
      issue: "Reviewers commonly downgrade unjustified maximum-severity ratings, which then invalidates the downstream classification decisions.",
      source_doc_id: "QMS-SOP-007",
      source_doc_version: "v1.4",
      reviewer: "Risk Manager",
      status: "active",
      created_at: "2026-05-19T16:30:00Z",
    },
  },
];

// ---------------------------------------------------------------
// Operations
// ---------------------------------------------------------------

async function clearSeedData(): Promise<void> {
  console.log("Clearing existing seed data...");
  const patterns = ["qms:projects:*", "qms:decisions:*", "qms:lessons:*"];
  let total = 0;
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      total += keys.length;
    }
  }
  console.log(`  Removed ${total} keys.`);
}

async function seedProjectFacts(): Promise<number> {
  console.log("\nSeeding project facts...");
  let count = 0;
  for (const [projectId, facts] of Object.entries(projectFacts)) {
    if (PROJECT_FILTER && !projectId.startsWith(PROJECT_FILTER)) continue;
    for (const [factKey, value] of Object.entries(facts)) {
      const key = `qms:projects:${projectId}:${factKey}`;
      await redis.set(key, JSON.stringify({
        ...value,
        _stored_at: new Date().toISOString(),
      }));
      count++;
    }
    console.log(`  ${projectId}: ${Object.keys(facts).length} facts`);
  }
  return count;
}

async function seedStandingDecisions(): Promise<number> {
  console.log("\nSeeding standing decisions...");
  if (PROJECT_FILTER) {
    console.log("  (skipped - --project filter active)");
    return 0;
  }
  for (const decision of standingDecisions) {
    await redis.set(decision.key, JSON.stringify(decision.value));
    console.log(`  ${decision.key}`);
  }
  return standingDecisions.length;
}

async function seedLessons(): Promise<number> {
  console.log("\nSeeding lessons...");
  if (PROJECT_FILTER) {
    console.log("  (skipped - --project filter active)");
    return 0;
  }
  let count = 0;
  for (const lesson of lessons) {
    const id = `seed-${count.toString().padStart(3, "0")}`;
    const key = `qms:lessons:${lesson.docType}:${id}`;
    await redis.set(key, JSON.stringify({ id, ...lesson.payload }));
    console.log(`  ${key}`);
    count++;
  }
  return count;
}

async function summary(): Promise<void> {
  console.log("\n=== Summary ===");
  const counts = {
    projects: (await redis.keys("qms:projects:*")).length,
    decisions: (await redis.keys("qms:decisions:*")).length,
    lessons: (await redis.keys("qms:lessons:*")).length,
  };
  console.log(`  Project fact keys:      ${counts.projects}`);
  console.log(`  Standing decision keys: ${counts.decisions}`);
  console.log(`  Lesson keys:            ${counts.lessons}`);
  console.log(`  Total:                  ${counts.projects + counts.decisions + counts.lessons}`);
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Redis seed for QMS Agent");
  console.log(`Target Redis: ${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? 6379}`);
  if (PROJECT_FILTER) console.log(`Project filter: ${PROJECT_FILTER}`);

  // Verify Redis is reachable
  try {
    await redis.ping();
  } catch (err) {
    console.error("Could not connect to Redis. Is the service running?");
    console.error("  brew services start redis");
    process.exit(1);
  }

  if (CLEAR_FIRST) {
    await clearSeedData();
  }

  const facts = await seedProjectFacts();
  const decisions = await seedStandingDecisions();
  const lessonCount = await seedLessons();

  console.log(`\nWrote ${facts + decisions + lessonCount} keys in this run.`);
  await summary();

  await redis.quit();
}

main().catch(async (err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  try {
    await redis.quit();
  } catch { /* ignore */ }
  process.exit(1);
});