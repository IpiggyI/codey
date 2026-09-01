use std::collections::BTreeMap;

use serde::Serialize;

use crate::fs_util::sha256_hex;

pub const OWNERSHIP_KEY_SEPARATOR: char = '#';
pub const FINGERPRINT_LEN: usize = 12;

pub fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

pub fn fingerprint(normalized_base_url: &str) -> String {
    let digest = sha256_hex(normalized_base_url.as_bytes());
    digest[..FINGERPRINT_LEN].to_string()
}

pub fn ownership_key(provider_id: &str, normalized_base_url: &str) -> String {
    format!(
        "{}{}{}",
        provider_id.trim(),
        OWNERSHIP_KEY_SEPARATOR,
        fingerprint(&normalize_base_url(normalized_base_url))
    )
}

pub fn is_ownership_key(key: &str) -> bool {
    key.rsplit_once(OWNERSHIP_KEY_SEPARATOR)
        .is_some_and(|(_, fingerprint)| {
            fingerprint.len() == FINGERPRINT_LEN
                && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentProviderSnapshot {
    pub id: String,
    pub base_url: String,
    pub wire_api: String,
    pub uses_official_account_auth: bool,
    pub ownership_key: String,
}

impl CurrentProviderSnapshot {
    pub fn from_parts(
        id: impl Into<String>,
        base_url: impl Into<String>,
        wire_api: impl Into<String>,
        uses_official_account_auth: bool,
    ) -> Self {
        let id = id.into().trim().to_string();
        let base_url = normalize_base_url(&base_url.into());
        let wire_api = {
            let trimmed = wire_api.into().trim().to_string();
            if trimmed.is_empty() {
                "responses".to_string()
            } else {
                trimmed
            }
        };
        let ownership_key = ownership_key(&id, &base_url);
        Self {
            id,
            base_url,
            wire_api,
            uses_official_account_auth,
            ownership_key,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationOutcome {
    Migrated { from: String, to: String },
    AlreadyPresent { key: String },
    Unproven { key: String },
}

impl MigrationOutcome {
    pub fn changed(&self) -> bool {
        matches!(self, Self::Migrated { .. })
    }
}

pub fn migrate_model_maps(
    maps: [&mut BTreeMap<String, Vec<String>>; 4],
    legacy_profiles: impl IntoIterator<Item = (String, String)>,
    snapshot: &CurrentProviderSnapshot,
) -> MigrationOutcome {
    let to = snapshot.ownership_key.clone();
    if maps.iter().any(|map| map.contains_key(&to)) {
        return MigrationOutcome::AlreadyPresent { key: to };
    }
    let Some(from) = matching_legacy_key(legacy_profiles, snapshot) else {
        return MigrationOutcome::Unproven { key: to };
    };
    if from == to {
        return MigrationOutcome::AlreadyPresent { key: to };
    }
    for map in maps {
        if let Some(models) = map.get(&from).cloned() {
            map.insert(to.clone(), models);
        }
    }
    MigrationOutcome::Migrated { from, to }
}

fn matching_legacy_key(
    legacy_profiles: impl IntoIterator<Item = (String, String)>,
    snapshot: &CurrentProviderSnapshot,
) -> Option<String> {
    legacy_profiles
        .into_iter()
        .find_map(|(provider_id, base_url)| {
            let provider_id = provider_id.trim();
            if provider_id == snapshot.id && normalize_base_url(&base_url) == snapshot.base_url {
                Some(provider_id.to_string())
            } else {
                None
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY_URL: &str = "https://relay.example/v1";
    const OTHER_URL: &str = "https://other.example/v1";
    const RELAY_FINGERPRINT: &str = "889271d70d18";
    const OTHER_FINGERPRINT: &str = "a3d9c9d847e2";

    fn snapshot_for(url: &str) -> CurrentProviderSnapshot {
        CurrentProviderSnapshot::from_parts("relay", url, "responses", false)
    }

    fn four_maps(selected: BTreeMap<String, Vec<String>>) -> [BTreeMap<String, Vec<String>>; 4] {
        [selected, BTreeMap::new(), BTreeMap::new(), BTreeMap::new()]
    }

    #[test]
    fn ownership_key_uses_twelve_hex_fingerprint_of_normalized_url() {
        assert_eq!(
            ownership_key("relay", "https://relay.example/v1/"),
            format!("relay#{RELAY_FINGERPRINT}")
        );
        assert!(is_ownership_key(&format!("relay#{RELAY_FINGERPRINT}")));
        assert!(!is_ownership_key("relay"));
    }

    #[test]
    fn same_id_different_address_does_not_copy_the_old_list() {
        let mut selected = BTreeMap::new();
        selected.insert("relay".into(), vec!["old-model".into()]);
        let mut maps = four_maps(selected);
        let [selected, manual, declared, upstream] = &mut maps;
        let outcome = migrate_model_maps(
            [selected, manual, declared, upstream],
            vec![("relay".into(), RELAY_URL.into())],
            &snapshot_for(OTHER_URL),
        );

        assert_eq!(
            outcome,
            MigrationOutcome::Unproven {
                key: format!("relay#{OTHER_FINGERPRINT}"),
            }
        );
        assert_eq!(
            maps[0].get("relay").unwrap(),
            &vec!["old-model".to_string()]
        );
        assert!(!maps[0].contains_key(&format!("relay#{OTHER_FINGERPRINT}")));
    }

    #[test]
    fn unproven_legacy_ownership_is_treated_as_empty() {
        let mut selected = BTreeMap::new();
        selected.insert("relay".into(), vec!["orphaned".into()]);
        let mut maps = four_maps(selected);
        let [selected, manual, declared, upstream] = &mut maps;
        let outcome = migrate_model_maps(
            [selected, manual, declared, upstream],
            Vec::<(String, String)>::new(),
            &snapshot_for(RELAY_URL),
        );

        assert_eq!(
            outcome,
            MigrationOutcome::Unproven {
                key: format!("relay#{RELAY_FINGERPRINT}"),
            }
        );
        assert!(!maps[0].contains_key(&format!("relay#{RELAY_FINGERPRINT}")));
        assert_eq!(maps[0].get("relay").unwrap(), &vec!["orphaned".to_string()]);
    }

    #[test]
    fn matching_base_url_copies_all_four_maps_and_keeps_the_old_keys() {
        let mut selected = BTreeMap::new();
        selected.insert("relay".into(), vec!["gpt-relay".into()]);
        let mut manual = BTreeMap::new();
        manual.insert("relay".into(), vec!["hand-typed".into()]);
        let mut declared = BTreeMap::new();
        declared.insert("relay".into(), vec!["gpt-5.6-sol".into()]);
        let mut upstream = BTreeMap::new();
        upstream.insert(
            "relay".into(),
            vec!["gpt-relay".into(), "gpt-5.6-sol".into()],
        );
        let outcome = migrate_model_maps(
            [&mut selected, &mut manual, &mut declared, &mut upstream],
            vec![("relay".into(), "https://relay.example/v1/".into())],
            &snapshot_for(RELAY_URL),
        );
        let new_key = format!("relay#{RELAY_FINGERPRINT}");

        assert_eq!(
            outcome,
            MigrationOutcome::Migrated {
                from: "relay".into(),
                to: new_key.clone(),
            }
        );
        assert_eq!(
            selected.get("relay").unwrap(),
            &vec!["gpt-relay".to_string()]
        );
        assert_eq!(
            selected.get(&new_key).unwrap(),
            &vec!["gpt-relay".to_string()]
        );
        assert_eq!(
            manual.get(&new_key).unwrap(),
            &vec!["hand-typed".to_string()]
        );
        assert_eq!(
            declared.get(&new_key).unwrap(),
            &vec!["gpt-5.6-sol".to_string()]
        );
        assert_eq!(
            upstream.get(&new_key).unwrap(),
            &vec!["gpt-relay".to_string(), "gpt-5.6-sol".to_string()]
        );
    }

    #[test]
    fn migration_is_idempotent_and_does_not_reread_old_keys() {
        let mut selected = BTreeMap::new();
        selected.insert("relay".into(), vec!["first".into()]);
        let mut maps = four_maps(selected);
        let snapshot = snapshot_for(RELAY_URL);
        {
            let [selected, manual, declared, upstream] = &mut maps;
            assert!(
                migrate_model_maps(
                    [selected, manual, declared, upstream],
                    vec![("relay".into(), RELAY_URL.into())],
                    &snapshot
                )
                .changed()
            );
        }
        maps[0].insert("relay".into(), vec!["changed-after-migrate".into()]);
        let [selected, manual, declared, upstream] = &mut maps;
        let outcome = migrate_model_maps(
            [selected, manual, declared, upstream],
            vec![("relay".into(), RELAY_URL.into())],
            &snapshot,
        );
        let new_key = format!("relay#{RELAY_FINGERPRINT}");

        assert_eq!(
            outcome,
            MigrationOutcome::AlreadyPresent {
                key: new_key.clone(),
            }
        );
        assert_eq!(maps[0].get(&new_key).unwrap(), &vec!["first".to_string()]);
        assert_eq!(
            maps[0].get("relay").unwrap(),
            &vec!["changed-after-migrate".to_string()]
        );
    }
}
