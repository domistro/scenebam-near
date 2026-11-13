//! SceneBam proof-of-creation registry.
//!
//! Every finished SceneBam film is written here once, keyed by the SHA-256 of
//! each delivered MP4 file. A record can never be overwritten or deleted, so
//! the first registration of a file is a permanent, timestamped claim of who
//! made it. Anyone can look up a file's hash with the `get_record` view.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearSchema, PanicOnDefault};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Key {
    Records,
    FileIndex,
    ByCreator,
    CreatorSet { creator_hash: Vec<u8> },
    Registrars,
}

/// One finished film. `files` holds the SHA-256 (hex) of every rendition
/// (16x9, 9x16, 1x1) so any of them resolves to the same record.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
#[abi(json, borsh)]
pub struct CreationRecord {
    /// Stable SceneBam production id (also the record id).
    pub production_id: String,
    /// NEAR account of the creator, or a pseudonymous `sb:` creator id when
    /// the creator has not linked a NEAR account yet.
    pub creator: String,
    /// Visual family: explainer, whiteboard, stickman, editorial.
    pub family: String,
    /// Hex SHA-256 of every delivered file, e.g. "16x9.mp4" -> hash.
    pub files: Vec<(String, String)>,
    /// Hash of the production's creative lineage (brief -> plan -> lock).
    pub lineage_hash: Option<String>,
    /// Optional proof that planning ran in a TEE (NEAR AI Cloud attestation
    /// or signed-response digest).
    pub ai_attestation: Option<String>,
    /// Account that wrote the record (the SceneBam registrar or the creator).
    pub registrar: AccountId,
    pub block_height: u64,
    /// Nanoseconds since the Unix epoch.
    pub timestamp_ns: u64,
}

#[near(serializers = [json])]
pub struct RegisterArgs {
    pub production_id: String,
    pub creator: String,
    pub family: String,
    pub files: Vec<(String, String)>,
    pub lineage_hash: Option<String>,
    pub ai_attestation: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    registrars: IterableSet<AccountId>,
    records: LookupMap<String, CreationRecord>,
    file_index: LookupMap<String, String>,
    by_creator: LookupMap<String, IterableSet<String>>,
    total: u64,
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        let mut registrars = IterableSet::new(Key::Registrars);
        registrars.insert(owner.clone());
        Self {
            owner,
            registrars,
            records: LookupMap::new(Key::Records),
            file_index: LookupMap::new(Key::FileIndex),
            by_creator: LookupMap::new(Key::ByCreator),
            total: 0,
        }
    }

    pub fn add_registrar(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can add registrars");
        self.registrars.insert(account_id);
    }

    pub fn remove_registrar(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can remove registrars");
        self.registrars.remove(&account_id);
    }

    /// Write a permanent creation record. Callable by a SceneBam registrar,
    /// or by a creator registering their own work under their own account.
    pub fn register(&mut self, args: RegisterArgs) -> CreationRecord {
        let caller = env::predecessor_account_id();
        let is_registrar = self.registrars.contains(&caller);
        require!(
            is_registrar || args.creator == caller.as_str(),
            "Only a registrar or the creator themselves can register"
        );
        require!(!args.production_id.is_empty() && args.production_id.len() <= 128, "Invalid production id");
        require!(!args.creator.is_empty() && args.creator.len() <= 96, "Invalid creator");
        require!(args.family.len() <= 32, "Invalid family");
        require!(!args.files.is_empty() && args.files.len() <= 8, "Between 1 and 8 files");
        require!(self.records.get(&args.production_id).is_none(), "Production already registered");
        for (name, hash) in &args.files {
            require!(name.len() <= 64, "File name too long");
            require!(is_hex_sha256(hash), "File hash must be lowercase hex SHA-256");
            require!(self.file_index.get(hash).is_none(), "File already registered");
        }
        for hash in [&args.lineage_hash, &args.ai_attestation].into_iter().flatten() {
            require!(hash.len() <= 256, "Hash field too long");
        }

        let record = CreationRecord {
            production_id: args.production_id.clone(),
            creator: args.creator.clone(),
            family: args.family,
            files: args.files,
            lineage_hash: args.lineage_hash,
            ai_attestation: args.ai_attestation,
            registrar: caller,
            block_height: env::block_height(),
            timestamp_ns: env::block_timestamp(),
        };
        for (_, hash) in &record.files {
            self.file_index.insert(hash.clone(), record.production_id.clone());
        }
        let creator_set = self.by_creator.entry(record.creator.clone()).or_insert_with(|| {
            IterableSet::new(Key::CreatorSet { creator_hash: env::sha256(record.creator.as_bytes()) })
        });
        creator_set.insert(record.production_id.clone());
        self.records.insert(record.production_id.clone(), record.clone());
        self.total += 1;
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"scenebam_provenance\",\"version\":\"1.0.0\",\"event\":\"register\",\"data\":[{{\"production_id\":\"{}\",\"creator\":\"{}\"}}]}}",
            record.production_id, record.creator
        ));
        record
    }

    /// Look up a file by its SHA-256 (hex). Returns the creation record.
    pub fn get_record(&self, file_hash: String) -> Option<CreationRecord> {
        let id = self.file_index.get(&file_hash.to_ascii_lowercase())?;
        self.records.get(id).cloned()
    }

    pub fn get_production(&self, production_id: String) -> Option<CreationRecord> {
        self.records.get(&production_id).cloned()
    }

    pub fn records_by_creator(&self, creator: String, from_index: Option<u32>, limit: Option<u32>) -> Vec<CreationRecord> {
        let Some(ids) = self.by_creator.get(&creator) else { return vec![] };
        ids.iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(20).min(50) as usize)
            .filter_map(|id| self.records.get(id).cloned())
            .collect()
    }

    pub fn total_records(&self) -> u64 {
        self.total
    }

    pub fn is_registrar(&self, account_id: AccountId) -> bool {
        self.registrars.contains(&account_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn ctx(caller: AccountId) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(caller).block_timestamp(42).build());
    }

    fn args(id: &str, creator: &str, hash: &str) -> RegisterArgs {
        RegisterArgs {
            production_id: id.into(),
            creator: creator.into(),
            family: "whiteboard".into(),
            files: vec![("16x9.mp4".into(), hash.into())],
            lineage_hash: Some("lineage".into()),
            ai_attestation: None,
        }
    }

    #[test]
    fn registrar_registers_and_anyone_can_look_up() {
        ctx(accounts(0));
        let mut c = Registry::new(accounts(0));
        let r = c.register(args("p1", "sb:abc", H1));
        assert_eq!(r.timestamp_ns, 42);
        assert_eq!(c.get_record(H1.to_uppercase()).unwrap().production_id, "p1");
        assert_eq!(c.records_by_creator("sb:abc".into(), None, None).len(), 1);
        assert_eq!(c.total_records(), 1);
    }

    #[test]
    #[should_panic(expected = "File already registered")]
    fn records_are_immutable() {
        ctx(accounts(0));
        let mut c = Registry::new(accounts(0));
        c.register(args("p1", "sb:abc", H1));
        c.register(args("p2", "sb:thief", H1));
    }

    #[test]
    fn creator_can_self_register() {
        ctx(accounts(0));
        let mut c = Registry::new(accounts(0));
        ctx(accounts(1));
        c.register(args("p9", accounts(1).as_str(), H2));
        assert!(c.get_record(H2.into()).is_some());
    }

    #[test]
    #[should_panic(expected = "Only a registrar or the creator")]
    fn strangers_cannot_claim_others_work() {
        ctx(accounts(0));
        let mut c = Registry::new(accounts(0));
        ctx(accounts(2));
        c.register(args("p3", accounts(1).as_str(), H2));
    }
}
