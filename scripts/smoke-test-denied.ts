// scripts/smoke-test-denied.ts
//
// The auth FAIL case. A valid user who logs in is still DENIED access they lack
// - the fails-closed property. reviewer1 is a real ID Server user (login
// succeeds) with engineering:internal only; they must NOT reach the quality
// domain, nor engineering:restricted data. Contrasted with dmaher, who has both.
//
// Exercises the SAME entitlement resolution the request middleware uses
// (getEntitlementProvider + isPermitted), so a green run proves the enforcement
// the whole stack relies on, not a mock of it.
//
// Needs the ID Server running (:3001). No LLM, no Qdrant.
//
// Usage: npm run integration:denied

import { idServerLogin } from "./_login.js";
import { getEntitlementProvider, isPermitted } from "../src/identity/index.js";
import { closeAllServices } from "../src/services.js";

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

async function main(): Promise<void> {
  console.log("=== Auth fail-case smoke test (reviewer1) ===\n");

  // 1. reviewer1 is a VALID user — login succeeds. Denial is about entitlement,
  //    not authentication.
  const token = await idServerLogin("reviewer1", "thisisatest");
  check("reviewer1 logs in (valid user)", Boolean(token));

  // 2. A WRONG password is rejected outright.
  let wrongRejected = false;
  try {
    await idServerLogin("reviewer1", "not-the-password");
  } catch {
    wrongRejected = true;
  }
  check("wrong password is rejected at login", wrongRejected);

  const provider = getEntitlementProvider();

  // 3. reviewer1 IS permitted in engineering, at INTERNAL only.
  const revEng = await provider.resolve("reviewer1", "engineering");
  check("reviewer1 permitted in engineering", isPermitted(revEng));
  check("  reviewer1 has engineering:internal", revEng.labels.includes("engineering:internal"));
  check("  reviewer1 does NOT have engineering:restricted (fails closed on restricted)",
    !revEng.labels.includes("engineering:restricted"), revEng.labels.join(","));

  // 4. THE FAIL CASE: reviewer1 is denied the quality domain entirely.
  const revQual = await provider.resolve("reviewer1", "quality");
  check("reviewer1 DENIED in quality (fails closed)", !isPermitted(revQual));
  check("  no quality labels leak to reviewer1", revQual.labels.length === 0, revQual.labels.join(","));

  // 5. Contrast — dmaher (the integration user) IS permitted where reviewer1 is not.
  const dmQual = await provider.resolve("dmaher", "quality");
  check("dmaher permitted in quality (contrast)", isPermitted(dmQual));
  const dmEng = await provider.resolve("dmaher", "engineering");
  check("dmaher HAS engineering:restricted (contrast)", dmEng.labels.includes("engineering:restricted"));

  await closeAllServices().catch(() => {});
  console.log("");
  if (failed === 0) console.log(`${GREEN}Auth denies the right things.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeAllServices().catch(() => {});
  process.exit(1);
});
