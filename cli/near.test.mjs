import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, sha256File, DEFAULT_CONTRACT } from "./near.mjs";

test("hashes a file as lowercase hex SHA-256", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "sb-")), "a.mp4");
  writeFileSync(f, "abc");
  assert.equal(sha256File(f), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("defaults to the live testnet registry", () => {
  const c = config({});
  assert.equal(c.network, "testnet");
  assert.equal(c.contractId, DEFAULT_CONTRACT);
  assert.equal(config({ NEAR_NETWORK: "mainnet" }).rpc, "https://rpc.mainnet.near.org");
});
