// Proof of creation on NEAR.
//
// When a film finishes, the worker writes one permanent record to the
// SceneBam provenance contract on NEAR: the SHA-256 of every delivered MP4,
// the creator, the creative lineage hash and (when planning ran on NEAR AI
// Cloud) the TEE attestation digest. Anyone can later hash a copy of the file
// and look it up on-chain without trusting SceneBam (see /verify).
//
// This module is off unless NEAR_PROVENANCE_ENABLED=1, and it never throws
// into the delivery path: a NEAR outage leaves the film delivered and the
// record marked "pending" for a later retry.
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

export type ProvenanceConfig = {
  network: "mainnet" | "testnet";
  rpcUrl: string;
  contractId: string;
  registrarId: string;
  registrarKey: string;
  creatorSalt: string;
};

export type ProvenanceResult = {
  status: "recorded" | "pending" | "disabled";
  network?: string;
  contractId?: string;
  transactionHash?: string;
  explorerUrl?: string;
  creator?: string;
  files?: Array<[string, string]>;
  error?: string;
  recordedAt?: string;
};

const RPC = { mainnet: "https://rpc.mainnet.near.org", testnet: "https://rpc.testnet.near.org" } as const;
const EXPLORER = { mainnet: "https://nearblocks.io/txns/", testnet: "https://testnet.nearblocks.io/txns/" } as const;

export function provenanceConfig(env: NodeJS.ProcessEnv = process.env): ProvenanceConfig | null {
  if (env.NEAR_PROVENANCE_ENABLED !== "1") return null;
  const network = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const contractId = String(env.NEAR_PROVENANCE_CONTRACT_ID || "").trim();
  const registrarId = String(env.NEAR_PROVENANCE_REGISTRAR_ID || "").trim();
  const registrarKey = String(env.NEAR_PROVENANCE_REGISTRAR_KEY || "").trim();
  const creatorSalt = String(env.NEAR_PROVENANCE_CREATOR_SALT || "").trim();
  if (!contractId || !registrarId || !registrarKey.startsWith("ed25519:") || creatorSalt.length < 16) return null;
  return { network, rpcUrl: env.NEAR_RPC_URL || RPC[network], contractId, registrarId, registrarKey, creatorSalt };
}

/** A creator's NEAR account when linked, otherwise a stable pseudonym that
 * reveals nothing about the person but lets them prove it later. */
export function creatorRef(userId: string, salt: string, nearAccountId?: string | null): string {
  if (nearAccountId && /^[a-z0-9._-]{2,64}$/.test(nearAccountId)) return nearAccountId;
  return `sb:${createHash("sha256").update(`${salt}:${userId}`).digest("hex").slice(0, 32)}`;
}

/** SHA-256 of every delivered rendition, in a stable order. */
export function deliveredFileHashes(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const name of ["16x9.mp4", "9x16.mp4", "1x1.mp4"]) {
    const file = path.join(dir, "files", name);
    if (existsSync(file)) out.push([name, createHash("sha256").update(readFileSync(file)).digest("hex")]);
  }
  return out;
}

function lineageHash(dir: string): string | null {
  for (const name of ["lineage.json", "creative-lock.json", "engine_request.json"]) {
    const file = path.join(dir, name);
    if (existsSync(file)) return createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return null;
}

function aiAttestation(dir: string): string | null {
  // Written by the planner when the route ran on NEAR AI Cloud (TEE).
  const file = path.join(dir, "ai-attestation.json");
  if (!existsSync(file)) return null;
  try {
    const a = JSON.parse(readFileSync(file, "utf8"));
    return typeof a.digest === "string" ? a.digest.slice(0, 256) : null;
  } catch { return null; }
}

function writeResult(dir: string, result: ProvenanceResult) {
  const file = path.join(dir, "provenance.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(result, null, 2));
  renameSync(tmp, file);
}

export async function recordProvenance(input: {
  jobId: string; dir: string; family: string; userId: string; nearAccountId?: string | null;
}, config = provenanceConfig()): Promise<ProvenanceResult> {
  if (!config) return { status: "disabled" };
  const files = deliveredFileHashes(input.dir);
  const creator = creatorRef(input.userId, config.creatorSalt, input.nearAccountId);
  const base = { network: config.network, contractId: config.contractId, creator, files };
  if (!files.length) return { ...base, status: "pending", error: "NO_DELIVERED_FILES" };
  // Read everything from disk before the first await: delivery cleanup may
  // run while the NEAR transaction is in flight.
  const lineage = lineageHash(input.dir);
  const attestation = aiAttestation(input.dir);
  try {
    const { Account, JsonRpcProvider } = await import("near-api-js");
    const provider = new JsonRpcProvider({ url: config.rpcUrl });
    const account = new Account(config.registrarId, provider, config.registrarKey as `ed25519:${string}`);
    const outcome = await account.callFunctionRaw({
      contractId: config.contractId,
      methodName: "register",
      args: { args: {
        production_id: input.jobId,
        creator,
        family: input.family,
        files,
        lineage_hash: lineage,
        ai_attestation: attestation,
      } },
      gas: 30_000_000_000_000n,
      deposit: 0n,
    });
    const transactionHash = (outcome as any)?.transaction?.hash ?? (outcome as any)?.transaction_outcome?.id;
    const result: ProvenanceResult = { ...base, status: "recorded", transactionHash,
      explorerUrl: transactionHash ? `${EXPLORER[config.network]}${transactionHash}` : undefined,
      recordedAt: new Date().toISOString() };
    writeResult(input.dir, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // "already registered" means an earlier attempt landed: not a failure.
    const result: ProvenanceResult = /already registered/i.test(message)
      ? { ...base, status: "recorded", recordedAt: new Date().toISOString() }
      : { ...base, status: "pending", error: message.slice(0, 300) };
    try { writeResult(input.dir, result); } catch { /* never block delivery */ }
    return result;
  }
}
