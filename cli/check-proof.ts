// Usage: node --import tsx cli/check-proof.ts <ai-attestation.json> [video.mp4]
// Re-checks a saved NEAR AI proof with no key: the signature recovers to the
// TEE signing address, the digest recomputes, and (given the video) the digest
// matches the ai_attestation stored in that film's NEAR record.
import { readFileSync } from "node:fs";
import { verifyMessage } from "ethers";
import { parseSignedText, proofDigest } from "../worker/near-ai-proof";
// @ts-ignore plain JS helper
import { config, sha256File, view } from "./near.mjs";

const [file, video] = process.argv.slice(2);
if (!file) { console.error("usage: node --import tsx cli/check-proof.ts <ai-attestation.json> [video.mp4]"); process.exit(2); }
const p = JSON.parse(readFileSync(file, "utf8"));
const { requestHash, responseHash } = parseSignedText(p.signedText);
const sigOk = verifyMessage(p.signedText, p.signature).toLowerCase() === p.signingAddress.toLowerCase();
const hashesOk = requestHash === p.requestHash && responseHash === p.responseHash;
const { digest, ...rest } = p;
const digestOk = proofDigest(rest) === digest;
console.log(`signature by TEE key ${p.signingAddress}: ${sigOk ? "✓" : "✕"}`);
console.log(`signed hashes match proof: ${hashesOk ? "✓" : "✕"}`);
console.log(`digest recomputes: ${digestOk ? "✓" : "✕"} ${digest}`);
let chainOk = true;
if (video) {
  const record = await view(config(), "get_record", { file_hash: sha256File(video) });
  chainOk = record?.ai_attestation === digest;
  console.log(`matches NEAR record of ${video}: ${chainOk ? "✓" : "✕"} ${record ? `(block ${record.block_height})` : "(no record)"}`);
}
process.exit(sigOk && hashesOk && digestOk && chainOk ? 0 : 1);
