//! Durable named references, independent of the bounded undo history.
use super::{
    Result, required,
    sessions::{Bridge, Session, Snapshot, atomic_write},
    validation,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

#[derive(Serialize, Deserialize)]
struct Version {
    version_id: String,
    session_id: String,
    source_sha256: String,
    label: String,
    revision: u64,
    snapshot: Snapshot,
}

impl Bridge {
    fn version_directory(&self, session: &Session, create: bool) -> Result<PathBuf> {
        let path = self
            .paths
            .root
            .join("sessions")
            .join(&session.id)
            .join("versions");
        if create {
            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        }
        if !path.exists() {
            return Ok(path);
        }
        if path.canonicalize().map_err(|e| e.to_string())? != path {
            return Err("INVALID_PATH: Version directory cannot contain symlinks".into());
        }
        Ok(path)
    }

    pub(super) fn save_version(&self, session: &Session, params: &Value) -> Result<Value> {
        session.check_revision(params)?;
        let label = required(params, "label")?.trim();
        if label.is_empty() || label.len() > 200 {
            return Err("INVALID_ARGUMENT: label must contain 1..200 bytes".into());
        }
        let version = Version {
            version_id: uuid::Uuid::new_v4().to_string(),
            session_id: session.id.clone(),
            source_sha256: session.source_sha256.clone(),
            label: label.into(),
            revision: session.revision,
            snapshot: session.current().clone(),
        };
        let path = self
            .version_directory(session, true)?
            .join(format!("{}.json", version.version_id));
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(&version).map_err(|e| e.to_string())?,
            false,
        )?;
        Ok(
            json!({"session_id":session.id,"version_id":version.version_id,"label":label,"revision":session.revision}),
        )
    }

    fn read_version(&self, session: &Session, id: &str) -> Result<Version> {
        let id =
            uuid::Uuid::parse_str(id).map_err(|_| "INVALID_ARGUMENT: version_id must be a UUID")?;
        let path = self
            .version_directory(session, false)?
            .join(format!("{id}.json"));
        let kind = fs::symlink_metadata(&path)
            .map_err(|e| format!("VERSION_NOT_FOUND: {e}"))?
            .file_type();
        if !kind.is_file() || kind.is_symlink() {
            return Err("INVALID_VERSION: Expected a regular file".into());
        }
        let version: Version = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if version.version_id != id.to_string()
            || version.session_id != session.id
            || version.source_sha256 != session.source_sha256
        {
            return Err(
                "INVALID_VERSION: Version does not belong to this session and source".into(),
            );
        }
        validation::validate_adjustments(&version.snapshot.adjustments, session.dimensions)?;
        super::sessions::validate_metadata(&version.snapshot.metadata)?;
        Ok(version)
    }

    pub(super) fn list_versions(&self, session: &Session) -> Result<Value> {
        let mut versions = Vec::new();
        let directory = self.version_directory(session, false)?;
        if !directory.exists() {
            return Ok(json!({"session_id":session.id,"versions":versions}));
        }
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("INVALID_VERSION: Missing id")?;
            let v = self.read_version(session, id)?;
            versions.push(json!({"version_id":v.version_id,"label":v.label,"revision":v.revision}));
        }
        versions.sort_by_key(|v| {
            (
                v["revision"].as_u64(),
                v["version_id"].as_str().unwrap().to_owned(),
            )
        });
        Ok(json!({"session_id":session.id,"versions":versions}))
    }

    pub(super) fn version_snapshot(&self, session: &Session, id: &str) -> Result<Snapshot> {
        Ok(self.read_version(session, id)?.snapshot)
    }

    pub(super) fn restore_version(&mut self, session: &Session, params: &Value) -> Result<Value> {
        session.check_revision(params)?;
        let version = self.read_version(session, required(params, "version_id")?)?;
        self.commit(
            &session.id,
            version.snapshot.adjustments,
            version.snapshot.metadata,
            &format!("Restored: {}", version.label),
        )
    }
}

/// Build a render-only state. Never enters history, persists, or alters a mask in place.
pub(super) fn temporary_session(
    session: &Session,
    snapshot: Option<Snapshot>,
    variant: &Value,
) -> Result<Session> {
    if !variant.is_object() {
        return Err("INVALID_ARGUMENT: variant must be an object".into());
    }
    if variant
        .as_object()
        .unwrap()
        .keys()
        .any(|key| !["label", "version_id", "patch", "disabled_masks"].contains(&key.as_str()))
    {
        return Err("INVALID_ARGUMENT: Unknown comparison variant field".into());
    }
    let mut snapshot = snapshot.unwrap_or_else(|| session.current().clone());
    if let Some(patch) = variant.get("patch") {
        validation::merge_patch(&mut snapshot.adjustments, patch)?;
    }
    if let Some(disabled) = variant.get("disabled_masks") {
        let ids = disabled
            .as_array()
            .ok_or("INVALID_ARGUMENT: disabled_masks must be an array")?;
        if ids.len() > 32 {
            return Err("INVALID_ARGUMENT: At most 32 disabled masks".into());
        }
        for id in ids {
            let id = id
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("INVALID_ARGUMENT: mask ids must be nonempty strings")?;
            let mask = snapshot.adjustments["masks"]
                .as_array_mut()
                .and_then(|masks| masks.iter_mut().find(|m| m["id"].as_str() == Some(id)))
                .ok_or_else(|| format!("MASK_NOT_FOUND: {id}"))?;
            mask["visible"] = json!(false);
        }
    }
    validation::validate_adjustments(&snapshot.adjustments, session.dimensions)?;
    let mut result = session.clone();
    result.history = vec![snapshot];
    result.cursor = 0;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporary_variants_preserve_input_history_and_validate_mask_ids() {
        let source = Session {
            id: "test".into(),
            source_path: "/source".into(),
            source_sha256: "a".repeat(64),
            working_path: "/working".into(),
            dimensions: (100, 100),
            is_raw: false,
            revision: 7,
            cursor: 0,
            history: vec![Snapshot {
                label: "accepted".into(),
                metadata: json!({"rating":5}),
                adjustments: json!({"exposure":0.2,"masks":[{"id":"a","name":"a","visible":true,"invert":false,"adjustments":{"exposure":1},"subMasks":[{"id":"shape","type":"all","visible":true,"mode":"additive","parameters":{}}]}]}),
            }],
        };
        let variant = temporary_session(
            &source,
            None,
            &json!({"patch":{"temperature":-10},"disabled_masks":["a"]}),
        )
        .unwrap();
        assert_eq!(source.current().adjustments["masks"][0]["visible"], true);
        assert_eq!(variant.current().adjustments["masks"][0]["visible"], false);
        assert_eq!(variant.current().adjustments["exposure"], 0.2);
        assert_eq!(source.revision, 7);
        assert_eq!(source.history.len(), 1);
        assert!(temporary_session(&source, None, &json!({"disabled_masks":["missing"]})).is_err());
        assert!(
            temporary_session(&source, None, &json!({"patch":{"notAnAdjustment":10}})).is_err()
        );
    }
}
