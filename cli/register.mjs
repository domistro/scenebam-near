#!/usr/bin/env node
// Usage: NEAR_ACCOUNT_ID=... NEAR_PRIVATE_KEY=ed25519:... \
//   node cli/register.mjs <production-id> <family> <creator> <file.mp4> [more.mp4 ...]
// Registers a finished film. The signer must be a registrar on the contract,
// or the creator registering their own work under their own account.
import { basename } from "node:path";
import { Account, JsonRpcProvider } from "near-api-js";
import { config, sha256File, view } from "./near.mjs";

const [productionId, family, creator, ...files] = process.argv.slice(2);
const { NEAR_ACCOUNT_ID: signer, NEAR_PRIVATE_KEY: key } = process.env;
if (!productionId || !family || !creator || !files.length || !signer || !key) {
  console.error("usage: NEAR_ACCOUNT_ID=.. NEAR_PRIVATE_KEY=ed25519:.. node cli/register.mjs <production-id> <family> <creator> <file.mp4>...");
  process.exit(2);
}
const cfg = config();
const hashes = files.map(f => [basename(f), sha256File(f)]);
// The contract refuses a file that is already registered. Check first so the
// person sees who holds the claim instead of a bare transaction failure.
for (const [name, hash] of hashes) {
  const existing = await view(cfg, "get_record", { file_hash: hash });
  if (existing) {
    console.error(`REJECTED: ${name} is already registered to ${existing.creator} ` +
      `at ${new Date(existing.timestamp_ns / 1e6).toISOString()} (block ${existing.block_height}, production ${existing.production_id}).`);
    process.exit(1);
  }
}
const account = new Account(signer, new JsonRpcProvider({ url: cfg.rpc }), key);
const out = await account.callFunctionRaw({ contractId: cfg.contractId, methodName: "register",
  args: { args: { production_id: productionId, creator, family,
    files: hashes, lineage_hash: null,
    ai_attestation: process.env.AI_ATTESTATION || null } },
  gas: 30_000_000_000_000n });
const tx = out?.transaction?.hash;
console.log(`registered ${productionId}: ${cfg.explorer}/txns/${tx}`);
