import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Wallet } from "ethers";
import { attestationBinds, parseSignedText, proofDigest, tdxReportData, verifySignedCompletion } from "./near-ai-proof";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tee = Wallet.createRandom();          // stands in for the key inside the TEE
const requestBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: "brief" }] });
const responseBody = JSON.stringify({ id: "chat-1", choices: [{ message: { content: "plan" } }] });
const signedText = `${sha(requestBody)}:${sha(responseBody)}`;
const signature = await tee.signMessage(signedText);

// A genuine completion verifies on all three checks.
const ok = verifySignedCompletion({ requestBody, responseBody, signedText, signature, signingAddress: tee.address });
assert.deepEqual(ok.checks, { requestHash: true, responseHash: true, signature: true });

// The 3-part variant of the signed text is understood.
assert.equal(parseSignedText(`x:${sha("a")}:${sha("b")}`).responseHash, sha("b"));

// A tampered response, or a signature from another key, fails.
assert.equal(verifySignedCompletion({ requestBody, responseBody: responseBody + " ", signedText, signature, signingAddress: tee.address }).checks.responseHash, false);
assert.equal(verifySignedCompletion({ requestBody, responseBody, signedText, signature: await Wallet.createRandom().signMessage(signedText), signingAddress: tee.address }).checks.signature, false);

// report_data binding: signing address padded to 32 bytes, then the nonce.
const nonce = randomBytes(32).toString("hex");
const reportData = tee.address.toLowerCase().slice(2).padEnd(64, "0") + nonce;
const quote = "00".repeat(568) + reportData + "00".repeat(40);
assert.equal(tdxReportData(quote), reportData);
assert.equal(attestationBinds(reportData, tee.address, nonce), true);
assert.equal(attestationBinds(reportData, Wallet.createRandom().address, nonce), false);
assert.equal(tdxReportData("00"), null);

// The on-chain digest is stable and changes with the content.
const base = { model: "m", chatId: "chat-1", requestHash: sha(requestBody), responseHash: sha(responseBody), signedText, signature,
  signingAddress: tee.address, checks: { ...ok.checks, attestationBinding: true } };
assert.match(proofDigest(base), /^[0-9a-f]{64}$/);
assert.notEqual(proofDigest(base), proofDigest({ ...base, responseHash: sha("other") }));
console.log("near-ai-proof: ok");
