#!/usr/bin/env node
// Usage: node cli/verify.mjs <video.mp4 | sha256>
// Prints the on-chain creation record for a file, or "NO RECORD". Needs no key.
import { existsSync } from "node:fs";
import { config, sha256File, view } from "./near.mjs";

const input = process.argv[2];
if (!input) { console.error("usage: node cli/verify.mjs <video.mp4 | sha256>"); process.exit(2); }
const hash = existsSync(input) ? sha256File(input) : input.toLowerCase();
if (!/^[0-9a-f]{64}$/.test(hash)) { console.error("not a file or a SHA-256 hash"); process.exit(2); }
const cfg = config();
const record = await view(cfg, "get_record", { file_hash: hash });
console.log(`sha256   ${hash}`);
console.log(`contract ${cfg.contractId} (${cfg.network})`);
if (!record) { console.log("NO RECORD: this exact file was never registered."); process.exit(1); }
console.log("VERIFIED: original SceneBam film");
console.log(`creator  ${record.creator}`);
console.log(`time     ${new Date(record.timestamp_ns / 1e6).toISOString()}`);
console.log(`block    ${record.block_height}  ${cfg.explorer}/blocks/${record.block_height}`);
console.log(`style    ${record.family}   production ${record.production_id}`);
console.log(`files    ${record.files.map(([n]) => n).join(", ")}`);
if (record.ai_attestation) console.log(`private AI attestation ${record.ai_attestation}`);
