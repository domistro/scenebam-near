import { KeyPair } from "near-api-js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { creatorRef, deliveredFileHashes, provenanceConfig, recordProvenance } from "./near-provenance";

// Off by default, and incomplete config stays off.
assert.equal(provenanceConfig({}), null);
assert.equal(provenanceConfig({ NEAR_PROVENANCE_ENABLED: "1", NEAR_PROVENANCE_CONTRACT_ID: "c.testnet" }), null);
assert.deepEqual(await recordProvenance({ jobId: "j", dir: "/nope", family: "x", userId: "u" }, null), { status: "disabled" });

// Pseudonyms are stable, unlinkable without the salt, and a linked NEAR account wins.
const a = creatorRef("user-1", "salt-salt-salt-salt");
assert.match(a, /^sb:[0-9a-f]{32}$/);
assert.equal(a, creatorRef("user-1", "salt-salt-salt-salt"));
assert.notEqual(a, creatorRef("user-1", "other-salt-other-salt"));
assert.equal(creatorRef("user-1", "salt-salt-salt-salt", "alice.near"), "alice.near");

// Hashes every delivered rendition in a fixed order.
const dir = mkdtempSync(path.join(tmpdir(), "prov-"));
mkdirSync(path.join(dir, "files"));
writeFileSync(path.join(dir, "files", "9x16.mp4"), "portrait");
writeFileSync(path.join(dir, "files", "16x9.mp4"), "landscape");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
assert.deepEqual(deliveredFileHashes(dir), [["16x9.mp4", sha("landscape")], ["9x16.mp4", sha("portrait")]]);

// A NEAR outage leaves the record pending and never throws.
const result = await recordProvenance({ jobId: "j1", dir, family: "whiteboard", userId: "u1" }, {
  network: "testnet", rpcUrl: "http://127.0.0.1:9", contractId: "c.testnet", registrarId: "r.testnet",
  registrarKey: KeyPair.fromRandom("ed25519").toString(), creatorSalt: "salt-salt-salt-salt" });
assert.equal(result.status, "pending");
assert.equal(result.files?.length, 2);
console.log("near-provenance: ok");
