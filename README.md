# SceneBam × NEAR: proof of creation for AI-made video

**Problem.** AI video is cheap to make and cheap to steal. A creator who posts
a film has no simple way to prove it is theirs when someone reposts it, claims
it, or edits it.

**Product.** [SceneBam](https://scenebam.online) turns a brief into a finished
animated film (whiteboard, explainer, stickman and editorial motion). With
this integration, every finished film gets a **permanent, timestamped record
on NEAR**. The record holds the SHA-256 of each delivered MP4 and the creator.
Records can never be overwritten, so the first registration of a file is
public proof of who made it and when. Anyone can check a copy, in a browser
or from the command line, against NEAR directly. Nobody has to trust
SceneBam's servers.

**How NEAR is used**
- A Rust `near-sdk` 5 contract (`contract/`) is the registry. It is
  immutable, keyed by file hash, and only a SceneBam registrar or the
  creator themselves can write.
- Verification is a plain NEAR JSON-RPC view call (`get_record`), so it is
  free and keyless and works from any static page.
- Planning on NEAR AI Cloud (TEE-backed private inference) is wired through
  the `ai_attestation` field. See [Private AI planning](#private-ai-planning-near-ai-cloud).

## Live deployment (testnet)

| | |
|---|---|
| Contract | [`scenebam-prov-mwfjzimv.testnet`](https://testnet.nearblocks.io/address/scenebam-prov-mwfjzimv.testnet) |
| Registered films | `demo/whiteboard-board.mp4` ([tx](https://testnet.nearblocks.io/txns/85cytqh4WXV6XSKNfS2gnag2dm9zmWGL4vwHJnxH297E)), `demo/explainer-sketch.mp4` ([tx](https://testnet.nearblocks.io/txns/2Rb5XhHts8ysPzr5gba1xQXV3SJg6BW4y51P65BBdZa9)), `demo/chalkboard.mp4` ([tx](https://testnet.nearblocks.io/txns/H2gwPpGLmbLVD6ZjxE1sQFYa4acHgsQc9N6bpDZNU3R9)) |
| Verify page | `web/index.html` (static, no build; also on GitHub Pages at https://domistro.github.io/scenebam-near/web/) |

The three demo films are real SceneBam output.

## Try it: do X, see Y

Requires Node 22+. The contract steps also need Rust.

**1. Verify a real film from the command line (no key, no account)**

```bash
npm install
node cli/verify.mjs demo/whiteboard-board.mp4
```

You should see `VERIFIED: original SceneBam film`, followed by creator
`sb:demo-creator-1`, the registration time, the block and the production id.

**2. Tamper with it and verify again**

```bash
cp demo/chalkboard.mp4 /tmp/edited.mp4 && printf x >> /tmp/edited.mp4
node cli/verify.mjs /tmp/edited.mp4
```

You should see `NO RECORD: this exact file was never registered.` with exit
code 1. Changing one byte breaks the match.

**3. Try to claim someone else's film**

```bash
NEAR_ACCOUNT_ID=anyone.testnet NEAR_PRIVATE_KEY=ed25519:x \
  node cli/register.mjs stolen whiteboard sb:thief demo/whiteboard-board.mp4
```

You should see `REJECTED: whiteboard-board.mp4 is already registered to
sb:demo-creator-1 at …`. The contract itself enforces the same rule; see test
`records_are_immutable`.

**4. Verify in the browser**

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/web/ and click **Whiteboard**, or drop any
file from `demo/`. You should see **✓ Original SceneBam film**. Drop
`/tmp/edited.mp4` and you should see **✕ No record found**. The file is
hashed in the browser and never uploaded.

**5. Contract tests**

```bash
cd contract && cargo test
```

You should see 4 passing tests:
- `registrar_registers_and_anyone_can_look_up`
- `records_are_immutable`
- `creator_can_self_register`
- `strangers_cannot_claim_others_work`

**6. Worker and CLI tests**

```bash
npm test
```

You should see `near-provenance: ok` and `# pass 2`.

**7. Deploy your own registry (optional)**

```bash
cd contract
RUSTFLAGS="-C target-cpu=mvp" cargo build --target wasm32-unknown-unknown --release
```

Deploy `target/wasm32-unknown-unknown/release/scenebam_provenance.wasm` with
`near-cli-rs` or `near-api-js` and call `new({"owner":"<you>.testnet"})`. Then
point the CLI at it:

```bash
NEAR_PROVENANCE_CONTRACT_ID=<you>.testnet node cli/register.mjs <id> <family> <creator> <file.mp4>
```

## Contract interface

| Method | Kind | What it does |
|---|---|---|
| `new(owner)` | init | Owner becomes the first registrar |
| `register(args)` | call | Writes `{production_id, creator, family, files: [[name, sha256]…], lineage_hash?, ai_attestation?}` with block height and timestamp. Rejects a reused file hash or production id, and rejects a caller who is neither a registrar nor the creator |
| `get_record(file_hash)` | view | Record for any rendition's SHA-256 |
| `get_production(production_id)` | view | Record by production |
| `records_by_creator(creator, from_index?, limit?)` | view | A creator's portfolio |
| `total_records()` | view | Count |
| `add_registrar` / `remove_registrar` | call (owner) | Manage SceneBam's signing workers |

Every registration emits a `scenebam_provenance` `EVENT_JSON` log for indexers.

## How it plugs into SceneBam

`worker/near-provenance.ts` is the module that runs inside SceneBam's render
worker. The SceneBam product repository is private and contains the video
engines. Once a film has passed QA and been published, the worker:
1. hashes every delivered rendition (16x9, 9x16, 1x1);
2. derives the creator id: their NEAR account if they linked one, otherwise a
   salted pseudonym `sb:<hash>` that reveals nothing about them;
3. sends `register`.

The call is detached and never blocks or fails a delivery. A NEAR outage
leaves the record `pending` for a retry. The feature is off unless
`NEAR_PROVENANCE_ENABLED=1`. `worker/near-provenance.test.ts` covers the
off-by-default behaviour, the pseudonyms, hashing and the outage path.

## Private AI planning (NEAR AI Cloud)

SceneBam's planner already speaks the OpenAI-compatible protocol, so it can
route a brief to a model running inside a TEE on NEAR AI Cloud
(`https://cloud-api.near.ai/v1`). The record's `ai_attestation` field holds
the digest of NEAR AI's signed response proof. A film can then show that it
was planned privately and is owned by this creator.

## Cost

Measured on testnet:
- **Contract code:** about 170 KB after `wasm-opt`, so about 1.7 NEAR held as a
  storage deposit.
- **Each film:** about 770 bytes, so about 0.008 NEAR of storage deposit, plus
  under 0.001 NEAR of gas.
- **Verification:** free (view calls).

## Honest limits

- A hash matches only the exact file SceneBam delivered. A re-encoded,
  trimmed or screen-recorded copy will not match. This proves the original;
  it does not detect derivatives.
- Pseudonymous creators (`sb:…`) can be tied to a person only by SceneBam,
  or by the creator later linking a NEAR account. Named NEAR accounts are
  verifiable by anyone.
- Failed contract calls currently surface in wallets as a generic Wasm trap
  rather than the panic text. The CLI checks first and prints the reason; the
  unit tests assert the exact messages.

## Hackathon disclosure (rules Q-002, Q-004, Q-005)

- **Before the hackathon:** SceneBam itself, its video engines, render worker
  and web app, which live in a private repository. It previously used Base
  USDC through Privy for payments and had no NEAR code.
- **Built during NEAR HACKATHON (Nov 2026):** everything in this repository,
  meaning the registry contract, the CLI, the verify page, the worker module
  and its tests, plus the hook inside SceneBam's private repository.
- **Libraries:** `near-sdk` 5.30 (Rust), `near-api-js` 7.5.3, `tsx`, Node's
  built-in test runner and `binaryen` (`wasm-opt`). AI coding assistance
  (Claude Code) was used.

## License

MIT; see `LICENSE`.
