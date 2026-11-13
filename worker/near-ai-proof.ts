// Private planning on NEAR AI Cloud, with a proof that can live on-chain.
//
// 1. Send the brief to a TEE-hosted model on NEAR AI Cloud and keep the exact
//    request bytes and the exact response bytes.
// 2. Fetch NEAR AI's signature for that completion. The signed text is
//    "<sha256(request)>:<sha256(response)>" and the signature is EIP-191
//    (personal_sign) by a key generated inside the TEE.
// 3. Check that both hashes match what we sent and received, and that the
//    signature recovers to the advertised signing address.
// 4. Fetch the TEE attestation report with a fresh nonce and check that the
//    Intel TDX quote's report_data commits to that signing address and nonce.
// 5. Reduce the proof to one SHA-256 digest. That digest goes into the
//    film's NEAR record (`ai_attestation`); the full proof is kept beside the
//    film so anyone can re-check it.
//
// Follows NEAR AI's reference verifier (github.com/nearai/nearai-cloud-verifier).
import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";

export const NEAR_AI_BASE = "https://cloud-api.near.ai/v1";
const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type PrivateProof = {
  model: string;
  chatId: string;
  requestHash: string;
  responseHash: string;
  signedText: string;
  signature: string;
  signingAddress: string;
  checks: { requestHash: boolean; responseHash: boolean; signature: boolean; attestationBinding: boolean | null };
  attestation?: { nonce: string; reportDataHex: string | null; hasIntelQuote: boolean; hasNvidiaPayload: boolean };
  digest: string;
};

/** Hashes inside the signed text; NEAR AI uses "req:resp" or "<prefix>:req:resp". */
export function parseSignedText(text: string): { requestHash: string; responseHash: string } {
  const parts = text.split(":");
  if (parts.length === 3) return { requestHash: parts[1], responseHash: parts[2] };
  if (parts.length === 2) return { requestHash: parts[0], responseHash: parts[1] };
  throw new Error("NEAR_AI_SIGNED_TEXT_UNRECOGNISED");
}

export function verifySignedCompletion(input: { requestBody: string; responseBody: string; signedText: string; signature: string; signingAddress: string }) {
  const { requestHash, responseHash } = parseSignedText(input.signedText);
  let recovered = "";
  try { recovered = verifyMessage(input.signedText, input.signature); } catch { /* invalid signature */ }
  return {
    requestHash, responseHash,
    checks: {
      requestHash: requestHash === sha256(input.requestBody),
      responseHash: responseHash === sha256(input.responseBody),
      signature: recovered.toLowerCase() === input.signingAddress.toLowerCase(),
    },
  };
}

/** TDX quote v4: 48-byte header, then the TD report; report_data is the last
 * 64 bytes of the 584-byte TD10 body, i.e. bytes [568, 632) of the quote. */
export function tdxReportData(intelQuoteHex: string): string | null {
  const hex = intelQuoteHex.replace(/^0x/, "");
  if (hex.length < 632 * 2) return null;
  return hex.slice(568 * 2, 632 * 2).toLowerCase();
}

/** report_data[0:32] = signing address right-padded to 32 bytes; [32:64] = nonce. */
export function attestationBinds(reportDataHex: string, signingAddress: string, nonceHex: string): boolean {
  const addr = signingAddress.toLowerCase().replace(/^0x/, "").padEnd(64, "0");
  return reportDataHex.slice(0, 64) === addr && reportDataHex.slice(64, 128) === nonceHex.toLowerCase();
}

export function proofDigest(p: Omit<PrivateProof, "digest">): string {
  return sha256(JSON.stringify({ v: 1, model: p.model, chatId: p.chatId, requestHash: p.requestHash,
    responseHash: p.responseHash, signature: p.signature, signingAddress: p.signingAddress }));
}

async function getJson(url: string, apiKey: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`NEAR_AI_${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Run one private completion and return its content with a verified proof. */
export async function privateChat(messages: ChatMessage[], opts: {
  model: string; apiKey: string; baseUrl?: string; maxTokens?: number;
}): Promise<{ content: string; proof: PrivateProof }> {
  const base = (opts.baseUrl || NEAR_AI_BASE).replace(/\/$/, "");
  const requestBody = JSON.stringify({ model: opts.model, messages, max_tokens: opts.maxTokens ?? 1200, stream: false });
  const res = await fetch(`${base}/chat/completions`, { method: "POST",
    headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" }, body: requestBody });
  const responseBody = await res.text();
  if (!res.ok) throw new Error(`NEAR_AI_${res.status}: ${responseBody.slice(0, 200)}`);
  const json = JSON.parse(responseBody);
  const chatId: string = json.id;
  const content: string = json.choices?.[0]?.message?.content ?? "";
  const model = encodeURIComponent(opts.model);

  const sig = await getJson(`${base}/signature/${encodeURIComponent(chatId)}?model=${model}&signing_algo=ecdsa`, opts.apiKey);
  const verified = verifySignedCompletion({ requestBody, responseBody, signedText: sig.text, signature: sig.signature, signingAddress: sig.signing_address });

  const nonce = randomBytes(32).toString("hex");
  let attestation: PrivateProof["attestation"]; let binding: boolean | null = null;
  try {
    const report = await getJson(`${base}/attestation/report?model=${model}&nonce=${nonce}&signing_algo=ecdsa&signing_address=${sig.signing_address}`, opts.apiKey);
    const entry = Array.isArray(report.model_attestations)
      ? report.model_attestations.find((a: any) => String(a.signing_address).toLowerCase() === String(sig.signing_address).toLowerCase()) ?? report.model_attestations[0]
      : report;
    const reportDataHex = entry?.intel_quote ? tdxReportData(entry.intel_quote) : null;
    binding = reportDataHex ? attestationBinds(reportDataHex, sig.signing_address, nonce) : null;
    attestation = { nonce, reportDataHex, hasIntelQuote: Boolean(entry?.intel_quote), hasNvidiaPayload: Boolean(entry?.nvidia_payload) };
  } catch { /* the completion proof still stands; binding stays unknown */ }

  const partial = { model: opts.model, chatId, requestHash: verified.requestHash, responseHash: verified.responseHash,
    signedText: sig.text, signature: sig.signature, signingAddress: sig.signing_address,
    checks: { ...verified.checks, attestationBinding: binding }, attestation };
  return { content, proof: { ...partial, digest: proofDigest(partial) } };
}
