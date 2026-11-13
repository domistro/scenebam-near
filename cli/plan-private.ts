// Usage: NEAR_AI_API_KEY=... node --import tsx cli/plan-private.ts "<brief>" [out.json]
// Plans a film on a TEE-hosted NEAR AI Cloud model and prints the plan, the
// verification checks and the proof digest to put in the NEAR record.
import { writeFileSync } from "node:fs";
import { privateChat } from "../worker/near-ai-proof";

const brief = process.argv[2];
const out = process.argv[3] || "ai-attestation.json";
const apiKey = process.env.NEAR_AI_API_KEY;
const model = process.env.NEAR_AI_MODEL || "deepseek-ai/DeepSeek-V4.1-Flash-1017";
if (!brief || !apiKey) { console.error('usage: NEAR_AI_API_KEY=.. node --import tsx cli/plan-private.ts "<brief>" [out.json]'); process.exit(2); }

const { content, proof } = await privateChat([
  { role: "system", content: "You plan short animated explainer films. Reply with a title and 4 numbered scenes, one line each." },
  { role: "user", content: brief },
], { model, apiKey, maxTokens: 400 });
writeFileSync(out, JSON.stringify(proof, null, 2));
console.log(content.trim(), "\n");
console.log(`model              ${proof.model} (TEE)`);
console.log(`request hash       ${proof.checks.requestHash ? "✓" : "✕"} ${proof.requestHash}`);
console.log(`response hash      ${proof.checks.responseHash ? "✓" : "✕"} ${proof.responseHash}`);
console.log(`signature          ${proof.checks.signature ? "✓" : "✕"} signed by ${proof.signingAddress}`);
console.log(`TEE key binding    ${proof.checks.attestationBinding === null ? "? not checked" : proof.checks.attestationBinding ? "✓ quote commits to this key" : "✕"}`);
console.log(`\nproof digest       ${proof.digest}\nsaved              ${out}`);
console.log(`\nregister with:     AI_ATTESTATION=${proof.digest} node cli/register.mjs ...`);
