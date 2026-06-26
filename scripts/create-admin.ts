// scripts/create-admin.ts
//
// Interactive script to bootstrap the first admin user.
// After the admin exists, subsequent users can be created via API
// endpoints in batch 3.
//
// Usage:
//   npm run create-admin

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { z } from "zod";
import { hashPassword, MIN_PASSWORD_LENGTH, validatePasswordPolicy } from "../src/api/auth/passwords.js";
import { createUser, findUserByEmail } from "../src/api/auth/store.js";
import { closeDb } from "../src/db/client.js";
import { closeAllServices } from "../src/services.js";

const emailSchema = z.string().email();

async function cleanup(): Promise<void> {
  await closeDb().catch(() => {});
  await closeAllServices().catch(() => {});
}

async function main(): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    console.log("=== Create Admin User ===\n");

    const email = (await rl.question("Email: ")).trim();
    const emailCheck = emailSchema.safeParse(email);
    if (!emailCheck.success) {
      console.error("Invalid email format");
      rl.close();
      await cleanup();
      process.exit(1);
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      console.error(`User with email ${email} already exists`);
      rl.close();
      await cleanup();
      process.exit(1);
    }

    const displayName = (await rl.question("Display name: ")).trim();
    if (displayName.length === 0) {
      console.error("Display name cannot be empty");
      rl.close();
      await cleanup();
      process.exit(1);
    }

    console.log(`\nNote: password will be visible as you type.`);
    console.log(`Minimum ${MIN_PASSWORD_LENGTH} characters.\n`);

    const password = await rl.question("Password: ");
    const policy = validatePasswordPolicy(password);
    if (!policy.valid) {
      console.error(policy.reason);
      rl.close();
      await cleanup();
      process.exit(1);
    }

    const confirm = await rl.question("Confirm password: ");
    if (password !== confirm) {
      console.error("Passwords do not match");
      rl.close();
      await cleanup();
      process.exit(1);
    }

    rl.close();

    console.log("\nHashing password (this takes a moment)...");
    const passwordHash = await hashPassword(password);

    console.log("Creating user...");
    const user = await createUser({
      email,
      password_hash: passwordHash,
      role: "admin",
      display_name: displayName,
    });

    console.log(`\nAdmin user created:`);
    console.log(`  ID:           ${user.id}`);
    console.log(`  Email:        ${user.email}`);
    console.log(`  Display name: ${user.display_name}`);
    console.log(`  Role:         ${user.role}`);
    console.log(`\nYou can now log in via:`);
    console.log(`  curl -X POST http://localhost:4000/api/v1/auth/login \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"email":"${user.email}","password":"<your password>"}'`);

    await cleanup();
  } catch (err) {
    console.error("\nFailed:", err instanceof Error ? err.message : err);
    rl.close();
    await cleanup();
    process.exit(1);
  }
}

main();