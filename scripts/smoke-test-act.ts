// scripts/smoke-test-act.ts
//
// The actioner role (Phase 6 of the agent-topology / custody-DAG spec). The
// actioner is the sole egress choke point; two invariants are enforced before
// any transport is touched. Proves:
//
//   - GATED: refused when no approver, or when approver == author (approver !=
//     author, same as the review flow) - and the transport is never touched
//   - allowed when an independent approver is present
//   - IDEMPOTENT: the same idempotencyKey delivers at most once; a repeat is a
//     "duplicate" receipt with no second delivery
//   - a refused send does NOT consume the idempotency key
//
// Pure/stub transport; no DB, no LLM.
//
// Usage: npm run smoke:act

import { makeActioner, type ActionRequest, type Receipt, type Transport } from "../src/orchestrator/actioner.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`${GREEN}OK${NC}   ${name}`);
  else {
    failed++;
    console.log(`${RED}FAIL${NC} ${name}${detail ? " - " + detail : ""}`);
  }
}

const ctx = { correlationId: "cor_act", runId: "run_act", producedAt: "2026-01-01T00:00:00.000Z" };

/** A stub transport that records every delivery. */
function recordingTransport(): Transport & { count: number } {
  const t = {
    count: 0,
    async deliver(): Promise<void> {
      t.count++;
    },
  };
  return t;
}

function req(over: Partial<ActionRequest>): ActionRequest {
  return { channel: "email", payload: { doc: "x" }, idempotencyKey: "k1", authorId: "u-author", approverId: "u-reviewer", ...over };
}

async function main(): Promise<void> {
  console.log("=== Actioner smoke test ===\n");

  // --- GATE ---
  {
    const transport = recordingTransport();
    const act = makeActioner("email", transport);
    const noApprover = (await act.run(req({ approverId: undefined }), ctx)).result as Receipt;
    check("refused when no approver", noApprover.status === "refused");
    check("refusal did not touch the transport", transport.count === 0);

    const selfApprove = (await act.run(req({ approverId: "u-author" }), ctx)).result as Receipt;
    check("refused when approver == author", selfApprove.status === "refused");
    check("still no delivery", transport.count === 0);
  }

  // --- ALLOWED + IDEMPOTENT ---
  {
    const transport = recordingTransport();
    const act = makeActioner("email", transport);

    const first = (await act.run(req({ idempotencyKey: "send-1" }), ctx)).result as Receipt;
    check("sent when an independent approver is present", first.status === "sent");
    check("transport delivered exactly once", transport.count === 1);

    const repeat = (await act.run(req({ idempotencyKey: "send-1" }), ctx)).result as Receipt;
    check("same idempotency key -> duplicate (not re-sent)", repeat.status === "duplicate");
    check("transport still delivered only once", transport.count === 1);

    const other = (await act.run(req({ idempotencyKey: "send-2" }), ctx)).result as Receipt;
    check("a different key delivers again", other.status === "sent" && transport.count === 2);
  }

  // --- A refused send must not burn the idempotency key ---
  {
    const transport = recordingTransport();
    const act = makeActioner("email", transport);
    const refused = (await act.run(req({ idempotencyKey: "k-reuse", approverId: undefined }), ctx)).result as Receipt;
    check("refused (no approver)", refused.status === "refused");
    const thenSent = (await act.run(req({ idempotencyKey: "k-reuse" }), ctx)).result as Receipt;
    check("the same key still sends once approved (refusal didn't consume it)", thenSent.status === "sent" && transport.count === 1);
  }

  console.log("");
  if (failed === 0) console.log(`${GREEN}Actioner is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
