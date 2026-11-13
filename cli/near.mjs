// Shared helpers: config, SHA-256 of a file, and a read-only contract view
// over plain NEAR JSON-RPC (no key, no SDK needed to verify).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const NETWORKS = {
  testnet: { rpc: "https://rpc.testnet.near.org", explorer: "https://testnet.nearblocks.io" },
  mainnet: { rpc: "https://rpc.mainnet.near.org", explorer: "https://nearblocks.io" },
};
// The live SceneBam registry used in the demo. Override with env vars.
export const DEFAULT_CONTRACT = "scenebam-prov-mwfjzimv.testnet";

export function config(env = process.env) {
  const network = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  return { network, ...NETWORKS[network], rpc: env.NEAR_RPC_URL || NETWORKS[network].rpc,
    contractId: env.NEAR_PROVENANCE_CONTRACT_ID || DEFAULT_CONTRACT };
}

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export async function view(cfg, method, args) {
  const res = await fetch(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "sb", method: "query", params: {
      request_type: "call_function", finality: "final", account_id: cfg.contractId,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) });
  const json = await res.json();
  if (json.error || json.result?.error) throw new Error(JSON.stringify(json.error ?? json.result.error).slice(0, 300));
  return JSON.parse(Buffer.from(json.result.result).toString());
}
