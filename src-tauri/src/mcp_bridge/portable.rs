//! Workspace-independent sessions. Bundles contain immutable working-source bytes,
//! all undo snapshots and named versions, inline masks/patches, and owned LUTs.
//! A manifest is published only after every dependency has been copied and hashed.
use super::{
    Result, required,
    sessions::{Bridge, Session, Snapshot, atomic_write, validate_metadata},
    validation,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const FORMAT: &str = "rapidraw-session-bundle";
const MAX_MANIFEST_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    path: String,
    sha256: String,
    bytes: u64,
    kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NamedVersion {
    version_id: String,
    session_id: String,
    source_sha256: String,
    label: String,
    revision: u64,
    snapshot: Snapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    format: String,
    format_version: u32,
    session: Session,
    versions: Vec<NamedVersion>,
    files: Vec<Asset>,
    provenance: Value,
}

fn hash_file(path: &Path) -> Result<(String, u64)> {
    let kind = fs::symlink_metadata(path).map_err(|e| format!("ASSET_NOT_FOUND: {e}"))?;
    if !kind.is_file() || kind.file_type().is_symlink() {
        return Err("INVALID_ASSET: Expected a regular file, not a symlink".into());
    }
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
        bytes += n as u64;
    }
    Ok((hex::encode(digest.finalize()), bytes))
}

fn digest_valid(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn relative_path(value: &str) -> Result<PathBuf> {
    // Reject Windows separators/drive prefixes on Unix too: a bundle may travel
    // between platforms, so host-only path parsing is insufficient.
    if value.is_empty() || value.contains('\\') || value.contains(':') {
        return Err("INVALID_BUNDLE: Asset path must be a portable relative path".into());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(
            "INVALID_BUNDLE: Asset path cannot contain traversal or empty components".into(),
        );
    }
    Ok(path.to_path_buf())
}

fn checked_file(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = relative_path(relative)?;
    let mut path = root.to_path_buf();
    for part in relative.components() {
        path.push(part);
        let metadata = fs::symlink_metadata(&path).map_err(|e| format!("ASSET_NOT_FOUND: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err(
                "INVALID_BUNDLE: Symlinked assets or parent directories are forbidden".into(),
            );
        }
    }
    if !path.is_file() {
        return Err("INVALID_BUNDLE: Asset must be a regular file".into());
    }
    Ok(path)
}

fn copy_hashed(source: &Path, target: &Path, kind: &str, relative: &str) -> Result<Asset> {
    // Hash the independent snapshot so bundles describe their captured bytes.
    let metadata = fs::symlink_metadata(source).map_err(|e| format!("ASSET_NOT_FOUND: {e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("INVALID_ASSET: Expected a regular file, not a symlink".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::storage_copy::copy_new(source, target).map_err(|e| e.to_string())?;
    let sha256 = crate::ai_enhance::digest(target).map_err(|e| e.to_string())?;
    let bytes = fs::metadata(target).map_err(|e| e.to_string())?.len();
    Ok(Asset {
        path: relative.into(),
        sha256,
        bytes,
        kind: kind.into(),
    })
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("INVALID_PATH: {e}"))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("INVALID_PATH: Expected a real directory, not a symlink".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}

fn child_directory(root: &Path, child: &str) -> Result<PathBuf> {
    let path = root.join(child);
    if !path.exists() {
        fs::create_dir(&path).map_err(|e| e.to_string())?;
    }
    let canonical = canonical_directory(&path)?;
    if canonical != path {
        return Err("INVALID_PATH: Workspace directory cannot contain symlinks".into());
    }
    Ok(path)
}

fn validate_snapshot(snapshot: &Snapshot, dimensions: (u32, u32)) -> Result<()> {
    validation::validate_adjustments(&snapshot.adjustments, dimensions)
        .map_err(|e| format!("INVALID_BUNDLE: {e}"))?;
    validate_metadata(&snapshot.metadata).map_err(|e| format!("INVALID_BUNDLE: {e}"))
}

fn read_named_versions(directory: &Path, session: &Session) -> Result<Vec<NamedVersion>> {
    let directory = directory.join("versions");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    canonical_directory(&directory)?;
    let mut versions = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }
        let file = checked_file(&directory, &name)?;
        if fs::metadata(&file).map_err(|e| e.to_string())?.len() > MAX_MANIFEST_BYTES {
            return Err("INVALID_VERSION: Version manifest exceeds size limit".into());
        }
        let version: NamedVersion =
            serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?)
                .map_err(|e| format!("INVALID_VERSION: {e}"))?;
        if uuid::Uuid::parse_str(&version.version_id).is_err()
            || name != format!("{}.json", version.version_id)
            || version.session_id != session.id
            || version.source_sha256 != session.source_sha256
        {
            return Err("INVALID_VERSION: Version identity does not match session".into());
        }
        validate_snapshot(&version.snapshot, session.dimensions)?;
        versions.push(version);
        if versions.len() > 4096 {
            return Err("INVALID_BUNDLE: At most 4096 named versions".into());
        }
    }
    versions.sort_by(|a, b| a.version_id.cmp(&b.version_id));
    Ok(versions)
}

fn bundle_lut(
    snapshot: &mut Snapshot,
    directory: &Path,
    assets: &mut BTreeMap<String, Asset>,
) -> Result<()> {
    let Some(source) = snapshot.adjustments["lutPath"].as_str().map(PathBuf::from) else {
        return Ok(());
    };
    let (sha, _) = hash_file(&source)?;
    let extension = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("cube")
        .to_ascii_lowercase();
    if !extension.bytes().all(|b| b.is_ascii_alphanumeric()) || extension.len() > 16 {
        return Err("INVALID_ASSET: Invalid LUT extension".into());
    }
    let relative = format!("assets/{sha}.{extension}");
    if !assets.contains_key(&relative) {
        let asset = copy_hashed(&source, &directory.join(&relative), "lut", &relative)?;
        if asset.sha256 != sha {
            return Err("ASSET_CHANGED: LUT changed while copying".into());
        }
        assets.insert(relative.clone(), asset);
    }
    snapshot.adjustments["lutPath"] = json!(relative);
    Ok(())
}

fn write_bundle(
    directory: &Path,
    session: &Session,
    mut versions: Vec<NamedVersion>,
    provenance: Value,
) -> Result<String> {
    let mut portable = session.clone();
    let extension = Path::new(&session.working_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    if !extension.bytes().all(|b| b.is_ascii_alphanumeric()) || extension.len() > 16 {
        return Err("INVALID_ASSET: Invalid source extension".into());
    }
    let source_relative = format!("source.{extension}");
    let asset = copy_hashed(
        Path::new(&session.working_path),
        &directory.join(&source_relative),
        "source",
        &source_relative,
    )?;
    if asset.sha256 != session.source_sha256 {
        return Err("SOURCE_CHANGED: Working source does not match recorded source SHA-256".into());
    }
    portable.working_path = source_relative.clone();
    let mut assets = BTreeMap::from([(source_relative, asset)]);
    for snapshot in &mut portable.history {
        bundle_lut(snapshot, directory, &mut assets)?;
    }
    for version in &mut versions {
        bundle_lut(&mut version.snapshot, directory, &mut assets)?;
    }
    let manifest = Bundle {
        format: FORMAT.into(),
        format_version: 1,
        session: portable,
        versions,
        files: assets.into_values().collect(),
        provenance,
    };
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("INVALID_BUNDLE: Manifest exceeds 512 MiB".into());
    }
    let sha = hex::encode(Sha256::digest(&bytes));
    atomic_write(&directory.join("manifest.json"), &bytes, false)?;
    Ok(sha)
}

fn read_bundle(directory: &Path, expected_sha: Option<&str>) -> Result<Bundle> {
    let manifest = checked_file(directory, "manifest.json")?;
    if fs::metadata(&manifest).map_err(|e| e.to_string())?.len() > MAX_MANIFEST_BYTES {
        return Err("INVALID_BUNDLE: Manifest exceeds 512 MiB".into());
    }
    let bytes = fs::read(manifest).map_err(|e| e.to_string())?;
    if let Some(expected) = expected_sha
        && (!digest_valid(expected)
            || hex::encode(Sha256::digest(&bytes)) != expected.to_ascii_lowercase())
    {
        return Err("BUNDLE_INTEGRITY: Manifest SHA-256 mismatch".into());
    }
    let bundle: Bundle =
        serde_json::from_slice(&bytes).map_err(|e| format!("INVALID_BUNDLE: {e}"))?;
    if bundle.format != FORMAT || bundle.format_version != 1 {
        return Err("INVALID_BUNDLE: Unsupported bundle format/version".into());
    }
    let session = &bundle.session;
    if uuid::Uuid::parse_str(&session.id).is_err()
        || !digest_valid(&session.source_sha256)
        || session.history.is_empty()
        || session.history.len() > 32
        || session.cursor >= session.history.len()
        || session.dimensions.0 == 0
        || session.dimensions.1 == 0
        || bundle.versions.len() > 4096
        || bundle.files.len() > 8192
    {
        return Err(
            "INVALID_BUNDLE: Invalid session identity, history, dimensions, or asset count".into(),
        );
    }
    let mut files = BTreeMap::new();
    let mut source_count = 0;
    for asset in &bundle.files {
        relative_path(&asset.path)?;
        if !digest_valid(&asset.sha256) || files.insert(asset.path.as_str(), asset).is_some() {
            return Err("INVALID_BUNDLE: Duplicate asset path or malformed digest".into());
        }
        match asset.kind.as_str() {
            "source" => {
                source_count += 1;
                if asset.path != session.working_path
                    || asset.path.contains('/')
                    || !asset.path.starts_with("source.")
                    || asset.sha256 != session.source_sha256
                {
                    return Err("INVALID_BUNDLE: Source identity/hash mismatch".into());
                }
            }
            "lut" if asset.path.starts_with("assets/") && asset.path.matches('/').count() == 1 => {}
            _ => return Err("INVALID_BUNDLE: Invalid asset kind or location".into()),
        }
        let path = checked_file(directory, &asset.path)?;
        let (sha, bytes) = hash_file(&path)?;
        if sha != asset.sha256 || bytes != asset.bytes {
            return Err(format!("BUNDLE_INTEGRITY: Asset mismatch: {}", asset.path));
        }
    }
    if source_count != 1 {
        return Err("INVALID_BUNDLE: Exactly one source is required".into());
    }
    let mut version_ids = BTreeSet::new();
    for version in &bundle.versions {
        if uuid::Uuid::parse_str(&version.version_id).is_err()
            || !version_ids.insert(&version.version_id)
            || version.session_id != session.id
            || version.source_sha256 != session.source_sha256
            || version.label.trim().is_empty()
            || version.label.len() > 200
        {
            return Err("INVALID_BUNDLE: Invalid named-version identity".into());
        }
    }
    for snapshot in session
        .history
        .iter()
        .chain(bundle.versions.iter().map(|v| &v.snapshot))
    {
        validate_snapshot(snapshot, session.dimensions)?;
        if let Some(path) = snapshot.adjustments["lutPath"].as_str() {
            relative_path(path)?;
            if files.get(path).is_none_or(|asset| asset.kind != "lut") {
                return Err("INVALID_BUNDLE: LUT reference is missing from manifest".into());
            }
            // Parse dependency too: a valid hash proves identity, not a usable LUT.
            crate::lut_processing::parse_lut_file(
                checked_file(directory, path)?.to_string_lossy().as_ref(),
            )
            .map_err(|e| format!("INVALID_BUNDLE: Invalid LUT: {e}"))?;
        }
    }
    Ok(bundle)
}

fn restore_bundle(
    root: &Path,
    directory: &Path,
    expected_sha: Option<&str>,
    fork: Option<(Option<&str>, &str)>,
) -> Result<Session> {
    let mut bundle = read_bundle(directory, expected_sha)?;
    let sessions = child_directory(root, "sessions")?;
    let id = uuid::Uuid::new_v4().to_string();
    let destination = sessions.join(&id);
    // Keep unpublished manifests outside sessions/: after a process crash,
    // startup must not mistake an abandoned staging directory for a session.
    let staging = tempfile::Builder::new()
        .prefix(".session-import-")
        .tempdir_in(root)
        .map_err(|e| e.to_string())?;
    for asset in &bundle.files {
        let copy = copy_hashed(
            &checked_file(directory, &asset.path)?,
            &staging.path().join(&asset.path),
            &asset.kind,
            &asset.path,
        )?;
        if copy.sha256 != asset.sha256 || copy.bytes != asset.bytes {
            return Err("BUNDLE_INTEGRITY: Asset changed during import".into());
        }
    }
    let original_id = bundle.session.id.clone();
    if let Some((version_id, label)) = fork {
        let mut snapshot = if let Some(version_id) = version_id {
            bundle
                .versions
                .iter()
                .find(|v| v.version_id == version_id)
                .ok_or("VERSION_NOT_FOUND: Unknown version id")?
                .snapshot
                .clone()
        } else {
            bundle.session.current().clone()
        };
        snapshot.label = label.into();
        bundle.session.history = vec![snapshot];
        bundle.session.cursor = 0;
        bundle.session.revision = 0;
    }
    bundle.session.id = id.clone();
    let working_relative = bundle.session.working_path.clone();
    bundle.session.working_path = destination
        .join(&working_relative)
        .to_string_lossy()
        .into_owned();
    // Original source paths are provenance, not dependencies. A source path from
    // another OS is preserved in provenance while using a local absolute locator.
    if !Path::new(&bundle.session.source_path).is_absolute() {
        bundle.session.source_path = directory
            .join(&working_relative)
            .to_string_lossy()
            .into_owned();
    }
    for snapshot in bundle
        .session
        .history
        .iter_mut()
        .chain(bundle.versions.iter_mut().map(|v| &mut v.snapshot))
    {
        if let Some(path) = snapshot.adjustments["lutPath"].as_str().map(str::to_string) {
            snapshot.adjustments["lutPath"] = json!(destination.join(relative_path(&path)?));
        }
    }
    if !bundle.versions.is_empty() {
        fs::create_dir(staging.path().join("versions")).map_err(|e| e.to_string())?;
    }
    for version in &mut bundle.versions {
        version.session_id = id.clone();
        atomic_write(
            &staging
                .path()
                .join("versions")
                .join(format!("{}.json", version.version_id)),
            &serde_json::to_vec_pretty(version).map_err(|e| e.to_string())?,
            false,
        )?;
    }
    let provenance = json!({"operation":if fork.is_some(){"fork_session"}else{"import_session_bundle"},"parent_session_id":original_id,"bundle_manifest_sha256":hash_file(&directory.join("manifest.json"))?.0,"bundle_provenance":bundle.provenance,"is_raw":bundle.session.is_raw});
    atomic_write(
        &staging.path().join("provenance.json"),
        &serde_json::to_vec_pretty(&provenance).map_err(|e| e.to_string())?,
        false,
    )?;
    atomic_write(
        &staging.path().join("session.json"),
        &serde_json::to_vec_pretty(&bundle.session).map_err(|e| e.to_string())?,
        false,
    )?;
    // Validate against the staging path using a temporary UUID location view.
    // Full validation after rename is rolled back if it fails; no session is
    // registered with the bridge until this function succeeds.
    fs::rename(staging.path(), &destination).map_err(|e| e.to_string())?;
    if let Err(error) = bundle.session.validate_restored(&destination) {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }
    Ok(bundle.session)
}

fn provenance(session: &Session, directory: &Path) -> Result<Value> {
    let prior = directory.join("provenance.json");
    let previous: Value = if prior.exists() {
        let prior = checked_file(directory, "provenance.json")?;
        serde_json::from_slice(&fs::read(prior).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        Value::Null
    };
    Ok(
        json!({"engine":"RapidRAW","exported_at":chrono::Utc::now().to_rfc3339(),"session_id":session.id,"revision":session.revision,"original_source_path":session.source_path,"original_source_sha256":session.source_sha256,"source_domain":{"is_raw":session.is_raw,"dimensions":session.dimensions},"previous":previous}),
    )
}

impl Bridge {
    pub(super) fn export_session_bundle(&self, session: &Session, params: &Value) -> Result<Value> {
        session.check_revision(params)?;
        let directory = self.paths.root.join("sessions").join(&session.id);
        session.validate_restored(&directory)?;
        let bundles = child_directory(&self.paths.root, "bundles")?;
        let name = params
            .get("name")
            .map(|_| required(params, "name").map(str::to_string))
            .transpose()?
            .unwrap_or_else(|| {
                format!(
                    "{}-r{}-{}",
                    session.id,
                    session.revision,
                    uuid::Uuid::new_v4()
                )
            });
        if name.len() > 160
            || relative_path(&name)?.components().count() != 1
            || name.starts_with('.')
        {
            return Err(
                "INVALID_ARGUMENT: Bundle name must be one visible filename of at most 160 bytes"
                    .into(),
            );
        }
        let target = bundles.join(name);
        if target.exists() || fs::symlink_metadata(&target).is_ok() {
            return Err("OUTPUT_EXISTS: Bundle already exists".into());
        }
        let staging = tempfile::Builder::new()
            .prefix(".bundle-")
            .tempdir_in(&bundles)
            .map_err(|e| e.to_string())?;
        let versions = read_named_versions(&directory, session)?;
        let count = versions.len();
        let sha = write_bundle(
            staging.path(),
            session,
            versions,
            provenance(session, &directory)?,
        )?;
        fs::rename(staging.path(), &target).map_err(|e| e.to_string())?;
        Ok(
            json!({"session_id":session.id,"revision":session.revision,"path":target,"manifest_sha256":sha,"format":FORMAT,"format_version":1,"history_snapshots":session.history.len(),"versions":count,"originals_unchanged":true,"portable_assets":"Working source, full history, named versions, owned LUTs, inline masks/depth maps/retouch patches, RAW interpretation and provenance"}),
        )
    }

    pub(super) fn import_session_bundle(&mut self, params: &Value) -> Result<Value> {
        let directory = canonical_directory(Path::new(required(params, "path")?))?;
        let expected = params
            .get("expected_manifest_sha256")
            .map(|_| required(params, "expected_manifest_sha256"))
            .transpose()?;
        let session = restore_bundle(&self.paths.root, &directory, expected, None)?;
        let mut info = session.info(true);
        info["imported_from"] = json!(directory);
        info["originals_unchanged"] = json!(true);
        self.sessions.insert(session.id.clone(), session);
        Ok(info)
    }

    pub(super) fn fork_session(&mut self, session: &Session, params: &Value) -> Result<Value> {
        session.check_revision(params)?;
        let directory = self.paths.root.join("sessions").join(&session.id);
        session.validate_restored(&directory)?;
        let version_id = params
            .get("version_id")
            .map(|_| required(params, "version_id"))
            .transpose()?;
        if let Some(id) = version_id {
            self.version_snapshot(session, id)?;
        }
        let label = params
            .get("label")
            .map(|_| required(params, "label"))
            .transpose()?
            .unwrap_or("Forked candidate")
            .trim();
        if label.is_empty() || label.len() > 200 {
            return Err("INVALID_ARGUMENT: label must contain 1..200 bytes".into());
        }
        let bundles = child_directory(&self.paths.root, "bundles")?;
        let temporary = tempfile::Builder::new()
            .prefix(".fork-")
            .tempdir_in(bundles)
            .map_err(|e| e.to_string())?;
        let sha = write_bundle(
            temporary.path(),
            session,
            read_named_versions(&directory, session)?,
            provenance(session, &directory)?,
        )?;
        let candidate = restore_bundle(
            &self.paths.root,
            temporary.path(),
            Some(&sha),
            Some((version_id, label)),
        )?;
        let mut info = candidate.info(true);
        info["parent_session_id"] = json!(session.id);
        info["parent_revision"] = json!(session.revision);
        info["parent_version_id"] = json!(version_id);
        self.sessions.insert(candidate.id.clone(), candidate);
        Ok(info)
    }

    pub(super) fn diff_versions(&self, session: &Session, params: &Value) -> Result<Value> {
        session.check_revision(params)?;
        let read = |key: &str| -> Result<Snapshot> {
            match params.get(key).filter(|v| !v.is_null()) {
                None => Ok(session.current().clone()),
                Some(value) => self.version_snapshot(
                    session,
                    value
                        .as_str()
                        .ok_or("INVALID_ARGUMENT: version id must be a string")?,
                ),
            }
        };
        let before = read("from_version_id")?;
        let after = read("to_version_id")?;
        let mut changes = Vec::new();
        value_diff(
            "/adjustments",
            &before.adjustments,
            &after.adjustments,
            &mut changes,
        );
        value_diff("/metadata", &before.metadata, &after.metadata, &mut changes);
        Ok(
            json!({"session_id":session.id,"revision":session.revision,"from_version_id":params.get("from_version_id").unwrap_or(&Value::Null),"to_version_id":params.get("to_version_id").unwrap_or(&Value::Null),"changes":changes,"equal":changes.is_empty(),"state_unchanged":true}),
        )
    }

    pub(super) fn copy_adjustments(&mut self, source: &Session, params: &Value) -> Result<Value> {
        source.check_revision(params)?;
        let snapshot = if let Some(id) = params.get("version_id") {
            self.version_snapshot(
                source,
                id.as_str()
                    .ok_or("INVALID_ARGUMENT: version_id must be a string")?,
            )?
        } else {
            source.current().clone()
        };
        let keys = copy_keys(params)?;
        let geometry = required(params, "geometry")?;
        if !["exclude", "require_same_dimensions"].contains(&geometry) {
            return Err("INVALID_ARGUMENT: Unknown geometry policy".into());
        }
        let mode = params
            .get("mode")
            .map(|_| required(params, "mode"))
            .transpose()?
            .unwrap_or("replace_selected");
        if !["merge", "replace_selected"].contains(&mode) {
            return Err("INVALID_ARGUMENT: Unknown copy mode".into());
        }
        let targets = params["targets"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 500)
            .ok_or("INVALID_ARGUMENT: targets must contain 1..500 items")?;
        let mut ids = BTreeSet::new();
        for item in targets {
            let id = required(item, "session_id")?;
            if id == source.id || !ids.insert(id) {
                return Err(
                    "INVALID_ARGUMENT: Targets must be unique and exclude the source session"
                        .into(),
                );
            }
            if item["expected_revision"].as_u64().is_none() {
                return Err("INVALID_ARGUMENT: Every target requires expected_revision".into());
            }
        }
        let mut results = Vec::new();
        for item in targets {
            let id = required(item, "session_id")?;
            let outcome = (|| -> Result<Value> {
                let target = self.session(item)?.clone();
                target.check_revision(item)?;
                let (mut adjustments, skipped) = selected_adjustments(
                    &snapshot.adjustments,
                    &target,
                    source.dimensions,
                    &keys,
                    geometry,
                    mode,
                )?;
                self.materialize_lut(&target, &mut adjustments)?;
                let mut result = self.commit(
                    &target.id,
                    adjustments,
                    target.current().metadata.clone(),
                    "Copied selected adjustments",
                )?;
                result["ok"] = json!(true);
                result["skipped_keys"] = json!(skipped);
                Ok(result)
            })();
            results.push(match outcome {
                Ok(value) => value,
                Err(error) => json!({"session_id":id,"ok":false,"error":error}),
            });
        }
        let failed = results.iter().filter(|v| v["ok"] == false).count();
        Ok(
            json!({"source_session_id":source.id,"source_revision":source.revision,"results":results,"succeeded":results.len()-failed,"failed":failed,"source_unchanged":true}),
        )
    }
}

fn copy_keys(params: &Value) -> Result<Vec<String>> {
    let schema = validation::adjustment_schema();
    let properties = schema["properties"]
        .as_object()
        .ok_or("INVALID_SCHEMA: Adjustment properties missing")?;
    let keys = params["keys"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= properties.len())
        .ok_or("INVALID_ARGUMENT: keys must contain explicit adjustment names")?;
    let mut result = Vec::new();
    for key in keys {
        let key = key
            .as_str()
            .ok_or("INVALID_ARGUMENT: keys must be strings")?;
        if !properties.contains_key(key) || result.iter().any(|existing| existing == key) {
            return Err(format!(
                "INVALID_ARGUMENT: Unknown or duplicate adjustment key: {key}"
            ));
        }
        result.push(key.to_string());
    }
    Ok(result)
}

fn geometry_key(key: &str) -> bool {
    key.starts_with("transform")
        || key.starts_with("lens")
        || matches!(
            key,
            "crop"
                | "rotation"
                | "orientationSteps"
                | "flipHorizontal"
                | "flipVertical"
                | "aspectRatio"
                | "guidedPerspective"
                | "masks"
                | "aiPatches"
                | "chromaticAberrationBlueYellow"
                | "chromaticAberrationRedCyan"
        )
}

fn selected_adjustments(
    source: &Value,
    target: &Session,
    source_dimensions: (u32, u32),
    keys: &[String],
    geometry: &str,
    mode: &str,
) -> Result<(Value, Vec<String>)> {
    let mut candidate = target.current().adjustments.clone();
    let mut skipped = Vec::new();
    let mut patch = json!({});
    for key in keys {
        if geometry_key(key) {
            if geometry == "exclude" {
                skipped.push(key.clone());
                continue;
            }
            if source_dimensions != target.dimensions {
                return Err("GEOMETRY_MISMATCH: Geometry-dependent adjustments require matching source dimensions".into());
            }
        }
        if mode == "replace_selected" {
            candidate.as_object_mut().unwrap().remove(key);
        }
        if let Some(value) = source.get(key) {
            patch[key] = value.clone();
        }
    }
    if skipped.len() == keys.len() {
        return Err(
            "INVALID_ARGUMENT: No selected adjustments remain after geometry exclusion".into(),
        );
    }
    validation::merge_patch(&mut candidate, &patch)?;
    // Copied mask ids must not share path-independent bitmap cache keys across
    // independent sessions. Only copied containers receive new identities.
    for collection in ["masks", "aiPatches"] {
        if patch.get(collection).is_some()
            && let Some(containers) = candidate[collection].as_array_mut()
        {
            for container in containers {
                container["id"] = json!(uuid::Uuid::new_v4());
                if let Some(submasks) = container["subMasks"].as_array_mut() {
                    for submask in submasks {
                        submask["id"] = json!(uuid::Uuid::new_v4());
                    }
                }
            }
        }
    }
    validation::validate_adjustments(&candidate, target.dimensions)?;
    Ok((candidate, skipped))
}

fn escaped_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn summarized(value: &Value) -> Value {
    if let Some(text) = value.as_str().filter(|s| s.len() > 512) {
        return json!({"type":"string","bytes":text.len(),"sha256":hex::encode(Sha256::digest(text.as_bytes()))});
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), summarized(v)))
                .collect(),
        ),
        Value::Array(array) => Value::Array(array.iter().map(summarized).collect()),
        _ => value.clone(),
    }
}

fn value_diff(path: &str, before: &Value, after: &Value, changes: &mut Vec<Value>) {
    if before == after {
        return;
    }
    if let (Some(before), Some(after)) = (before.as_object(), after.as_object()) {
        for key in before.keys().chain(after.keys()).collect::<BTreeSet<_>>() {
            let pointer = format!("{path}/{}", escaped_pointer(key));
            match (before.get(key), after.get(key)) {
                (Some(a), Some(b)) => value_diff(&pointer, a, b, changes),
                (Some(a), None) => changes
                    .push(json!({"path":pointer,"operation":"remove","before":summarized(a)})),
                (None, Some(b)) => {
                    changes.push(json!({"path":pointer,"operation":"add","after":summarized(b)}))
                }
                _ => {}
            }
        }
    } else {
        changes.push(json!({"path":path,"operation":"replace","before":summarized(before),"after":summarized(after)}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> Session {
        let id = uuid::Uuid::new_v4().to_string();
        let directory = root.join("sessions").join(&id);
        fs::create_dir_all(&directory).unwrap();
        let working = directory.join("source.tiff");
        let image = image::DynamicImage::ImageRgb32F(image::ImageBuffer::from_pixel(
            12,
            8,
            image::Rgb([0.1f32, 0.3, 0.7]),
        ));
        image
            .save_with_format(&working, image::ImageFormat::Tiff)
            .unwrap();
        let (sha, _) = hash_file(&working).unwrap();
        let mut adjustments = validation::default_adjustments();
        adjustments["exposure"] = json!(0.7);
        let session = Session {
            id,
            source_path: root.join("original.tiff").to_string_lossy().into_owned(),
            source_sha256: sha,
            working_path: working.to_string_lossy().into_owned(),
            dimensions: (12, 8),
            is_raw: true,
            revision: 4,
            cursor: 1,
            history: vec![
                Snapshot {
                    label: "Initial".into(),
                    adjustments: validation::default_adjustments(),
                    metadata: json!({"rating":0,"derivedFrom":{"operation":"denoise","source_domain_preserved":true}}),
                },
                Snapshot {
                    label: "Accepted".into(),
                    adjustments,
                    metadata: json!({"rating":4,"tags":["test"],"derivedFrom":{"operation":"denoise","source_domain_preserved":true}}),
                },
            ],
        };
        atomic_write(
            &directory.join("session.json"),
            &serde_json::to_vec(&session).unwrap(),
            false,
        )
        .unwrap();
        session
    }

    fn version(session: &Session) -> NamedVersion {
        NamedVersion {
            version_id: uuid::Uuid::new_v4().to_string(),
            session_id: session.id.clone(),
            source_sha256: session.source_sha256.clone(),
            label: "Baseline".into(),
            revision: 0,
            snapshot: session.history[0].clone(),
        }
    }

    fn make_bundle(
        root: &Path,
        session: &Session,
        versions: Vec<NamedVersion>,
    ) -> (PathBuf, String) {
        let directory = root.join(format!("bundle-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let sha = write_bundle(
            &directory,
            session,
            versions,
            json!({"test":true,"original_source_path":session.source_path}),
        )
        .unwrap();
        (directory, sha)
    }

    fn modify_manifest(directory: &Path, edit: impl FnOnce(&mut Value)) {
        let path = directory.join("manifest.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        edit(&mut value);
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn moved_bundle_restores_raw_domain_history_versions_and_independent_sources() {
        let original = tempfile::tempdir().unwrap();
        let source = fixture(original.path());
        let reference = version(&source);
        let (bundle, sha) = make_bundle(original.path(), &source, vec![reference.clone()]);
        let relocated = tempfile::tempdir().unwrap();
        let moved = relocated.path().join("portable");
        fs::rename(bundle, &moved).unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let restored = restore_bundle(
            &workspace.path().canonicalize().unwrap(),
            &moved,
            Some(&sha),
            None,
        )
        .unwrap();
        assert!(
            restored.is_raw,
            "A linear TIFF derived from RAW must keep its interpretation"
        );
        assert_ne!(restored.id, source.id);
        assert_eq!(restored.source_sha256, source.source_sha256);
        assert_eq!(restored.history.len(), 2);
        assert_eq!(restored.cursor, 1);
        assert_eq!(restored.revision, 4);
        assert_eq!(restored.current().metadata, source.current().metadata);
        assert_eq!(
            hash_file(Path::new(&restored.working_path)).unwrap().0,
            source.source_sha256
        );
        let directory = workspace.path().join("sessions").join(&restored.id);
        let versions = read_named_versions(&directory, &restored).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].version_id, reference.version_id);
        assert_eq!(versions[0].session_id, restored.id);
        assert!(directory.join("provenance.json").is_file());
        // Removing both old workspace and the transport bundle cannot break an
        // imported candidate; all dependencies belong to its new directory.
        drop(original);
        fs::remove_dir_all(moved).unwrap();
        assert!(super::super::sessions::restore_session(&directory).is_ok());
        let old_bytes = fs::read(&restored.working_path).unwrap();
        fs::write(
            &restored.working_path,
            b"candidate was independently changed",
        )
        .unwrap();
        assert_ne!(fs::read(&restored.working_path).unwrap(), old_bytes);
    }

    #[test]
    fn bundle_lut_and_inline_masks_survive_missing_original_workspace() {
        use base64::Engine as _;
        let original = tempfile::tempdir().unwrap();
        let mut source = fixture(original.path());
        let assets = Path::new(&source.working_path)
            .parent()
            .unwrap()
            .join("assets");
        fs::create_dir(&assets).unwrap();
        let lut = assets.join("identity.cube");
        fs::write(&lut, "TITLE \"Identity\"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n").unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(12, 8)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let bitmap = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        source.history[1].adjustments["lutPath"] = json!(lut);
        source.history[1].adjustments["lensBlurDepthMap"] = json!(bitmap.clone());
        let reference = NamedVersion {
            snapshot: source.history[1].clone(),
            ..version(&source)
        };
        let (bundle, sha) = make_bundle(original.path(), &source, vec![reference]);
        let destination = tempfile::tempdir().unwrap();
        let restored = restore_bundle(
            &destination.path().canonicalize().unwrap(),
            &bundle,
            Some(&sha),
            None,
        )
        .unwrap();
        let lut_path = PathBuf::from(restored.current().adjustments["lutPath"].as_str().unwrap());
        assert!(lut_path.starts_with(Path::new(&restored.working_path).parent().unwrap()));
        assert_eq!(fs::read(&lut_path).unwrap(), fs::read(&lut).unwrap());
        assert_eq!(restored.current().adjustments["lensBlurDepthMap"], bitmap);
        drop(original);
        assert!(crate::lut_processing::parse_lut_file(lut_path.to_str().unwrap()).is_ok());
        let versions = read_named_versions(
            Path::new(&restored.working_path).parent().unwrap(),
            &restored,
        )
        .unwrap();
        assert_eq!(
            versions[0].snapshot.adjustments["lutPath"],
            restored.current().adjustments["lutPath"]
        );
    }

    #[test]
    fn fork_from_named_version_is_independent_and_resets_revision() {
        let root = tempfile::tempdir().unwrap();
        let source = fixture(root.path());
        let reference = version(&source);
        let (bundle, sha) = make_bundle(root.path(), &source, vec![reference.clone()]);
        let candidate = restore_bundle(
            &root.path().canonicalize().unwrap(),
            &bundle,
            Some(&sha),
            Some((Some(&reference.version_id), "Cool candidate")),
        )
        .unwrap();
        assert_eq!(candidate.revision, 0);
        assert_eq!(candidate.history.len(), 1);
        assert_eq!(candidate.current().label, "Cool candidate");
        assert_eq!(
            candidate.current().adjustments,
            reference.snapshot.adjustments
        );
        assert_ne!(
            candidate.current().adjustments,
            source.current().adjustments
        );
        assert!(candidate.is_raw);
        fs::write(&candidate.working_path, b"independent").unwrap();
        assert_eq!(
            hash_file(Path::new(&source.working_path)).unwrap().0,
            source.source_sha256
        );
        let parent_versions = read_named_versions(
            Path::new(&candidate.working_path).parent().unwrap(),
            &candidate,
        )
        .unwrap();
        assert_eq!(parent_versions[0].session_id, candidate.id);
    }

    #[test]
    fn rejects_corrupt_missing_or_unlisted_assets_without_publishing_sessions() {
        for scenario in [
            "missing",
            "changed",
            "unlisted",
            "digest",
            "history",
            "source_hash",
        ] {
            let original = tempfile::tempdir().unwrap();
            let source = fixture(original.path());
            let (bundle, sha) = make_bundle(original.path(), &source, vec![]);
            match scenario {
                "missing" => fs::remove_file(bundle.join("source.tiff")).unwrap(),
                "changed" => fs::write(bundle.join("source.tiff"), b"corrupt").unwrap(),
                "unlisted" => modify_manifest(&bundle, |v| {
                    v["session"]["history"][0]["adjustments"]["lutPath"] =
                        json!("assets/missing.cube")
                }),
                "digest" => modify_manifest(&bundle, |v| v["files"][0]["sha256"] = json!("wrong")),
                "history" => modify_manifest(&bundle, |v| {
                    v["session"]["history"][0]["adjustments"]["typo"] = json!(42)
                }),
                "source_hash" => modify_manifest(&bundle, |v| {
                    v["session"]["source_sha256"] = json!("b".repeat(64))
                }),
                _ => unreachable!(),
            }
            let workspace = tempfile::tempdir().unwrap();
            assert!(
                restore_bundle(
                    &workspace.path().canonicalize().unwrap(),
                    &bundle,
                    None,
                    None
                )
                .is_err(),
                "{scenario}"
            );
            assert!(
                !workspace.path().join("sessions").exists(),
                "No session directory should be published for {scenario}"
            );
            if !["missing", "changed"].contains(&scenario) {
                assert!(
                    read_bundle(&bundle, Some(&sha))
                        .unwrap_err()
                        .contains("Manifest SHA-256")
                );
            }
        }
    }

    #[test]
    fn rejects_portable_path_traversal_and_symlinked_assets() {
        for bad in [
            "../outside",
            "/absolute",
            "assets/../../outside",
            "C:\\outside",
            "assets\\outside",
            "assets/./inside",
            "assets//inside",
            "source.tiff/",
        ] {
            assert!(relative_path(bad).is_err(), "Accepted {bad}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let original = tempfile::tempdir().unwrap();
            let source = fixture(original.path());
            let (bundle, _) = make_bundle(original.path(), &source, vec![]);
            fs::remove_file(bundle.join("source.tiff")).unwrap();
            symlink(&source.working_path, bundle.join("source.tiff")).unwrap();
            assert!(read_bundle(&bundle, None).unwrap_err().contains("Symlink"));
            assert_eq!(
                hash_file(Path::new(&source.working_path)).unwrap().0,
                source.source_sha256
            );
        }
    }

    #[test]
    fn duplicate_version_identity_and_wrong_owner_are_rejected() {
        let original = tempfile::tempdir().unwrap();
        let source = fixture(original.path());
        let reference = version(&source);
        let (bundle, _) = make_bundle(original.path(), &source, vec![reference.clone(), reference]);
        assert!(
            read_bundle(&bundle, None)
                .unwrap_err()
                .contains("named-version identity")
        );
        modify_manifest(&bundle, |v| {
            v["versions"].as_array_mut().unwrap().pop();
            v["versions"][0]["session_id"] = json!(uuid::Uuid::new_v4());
        });
        assert!(
            read_bundle(&bundle, None)
                .unwrap_err()
                .contains("named-version identity")
        );
    }

    #[test]
    fn selective_copy_respects_geometry_and_does_not_copy_metadata_or_share_mask_ids() {
        let root = tempfile::tempdir().unwrap();
        let target = fixture(root.path());
        let mut source = target.current().adjustments.clone();
        source["exposure"] = json!(-0.5);
        source["rotation"] = json!(12);
        source["masks"] = json!([{"id":"parent","name":"Whole image","visible":true,"invert":false,"adjustments":{"exposure":0.2},"subMasks":[{"id":"child","type":"all","visible":true,"mode":"additive","parameters":{}}]}]);
        let keys = vec!["exposure".into(), "rotation".into(), "masks".into()];
        let (candidate, skipped) = selected_adjustments(
            &source,
            &target,
            (24, 16),
            &keys,
            "exclude",
            "replace_selected",
        )
        .unwrap();
        assert_eq!(candidate["exposure"], -0.5);
        assert_eq!(
            candidate["rotation"],
            target.current().adjustments["rotation"]
        );
        assert_eq!(skipped, vec!["rotation", "masks"]);
        assert_eq!(target.current().adjustments["exposure"], 0.7);
        assert!(
            selected_adjustments(
                &source,
                &target,
                (24, 16),
                &keys,
                "require_same_dimensions",
                "replace_selected"
            )
            .unwrap_err()
            .contains("GEOMETRY_MISMATCH")
        );
        let (candidate, _) = selected_adjustments(
            &source,
            &target,
            target.dimensions,
            &keys,
            "require_same_dimensions",
            "replace_selected",
        )
        .unwrap();
        assert_eq!(candidate["rotation"], 12);
        assert_ne!(candidate["masks"][0]["id"], "parent");
        assert_ne!(candidate["masks"][0]["subMasks"][0]["id"], "child");
        assert_eq!(source["masks"][0]["id"], "parent");
        assert_eq!(target.current().metadata["rating"], 4);
    }

    #[test]
    fn version_diff_uses_json_pointers_and_hashes_large_embedded_assets() {
        let mut changes = Vec::new();
        value_diff(
            "/adjustments",
            &json!({"exposure":0,"asset": "a".repeat(1024), "special/key~":true}),
            &json!({"exposure":1,"asset":"b".repeat(1024),"added":2}),
            &mut changes,
        );
        assert_eq!(changes.len(), 4);
        assert!(
            changes
                .iter()
                .any(|v| v["path"] == "/adjustments/special~1key~0" && v["operation"] == "remove")
        );
        let asset = changes
            .iter()
            .find(|v| v["path"] == "/adjustments/asset")
            .unwrap();
        assert_eq!(asset["before"]["bytes"], 1024);
        assert_ne!(asset["before"]["sha256"], asset["after"]["sha256"]);
        assert!(
            !serde_json::to_string(asset)
                .unwrap()
                .contains(&"a".repeat(1024))
        );
    }
}
