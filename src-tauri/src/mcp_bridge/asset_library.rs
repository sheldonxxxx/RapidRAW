//! Agent-owned preset and LUT library. Every mutation is confined to
//! workspace/assets; imported originals and the GUI library remain untouched.
use super::{
    Result, flag, required,
    sessions::{Bridge, atomic_write},
    validation,
};
use crate::{
    file_management::{Preset, PresetFile, PresetItem},
    lut_processing::LutEntry,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LutAsset {
    name: String,
    extension: String,
    sha256: String,
    data_base64: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PresetEnvelope {
    format: String,
    version: u32,
    preset: Preset,
    dimensions: (u32, u32),
    lut: Option<LutAsset>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredLut {
    id: String,
    name: String,
    filename: String,
    sha256: String,
}

fn bounded_read(path: &Path) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("ASSET_NOT_FOUND: {e}"))?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_FILE_BYTES {
        return Err(
            "INVALID_ASSET: Expected a regular file of at most 128 MiB, without symlinks".into(),
        );
    }
    fs::read(path).map_err(|e| e.to_string())
}

fn safe_dir(path: &Path, create: bool) -> Result<PathBuf> {
    if !path.exists() && create {
        fs::create_dir(path).map_err(|e| e.to_string())?;
    }
    let kind = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !kind.is_dir() || kind.file_type().is_symlink() {
        return Err("INVALID_PATH: Managed asset directory cannot be a symlink".into());
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if canonical != path {
        return Err("INVALID_PATH: Managed asset parent cannot be a symlink".into());
    }
    Ok(canonical)
}

fn library(root: &Path, kind: &str) -> Result<PathBuf> {
    let assets = safe_dir(&root.join("assets"), true)?;
    safe_dir(&assets.join(kind), true)
}

fn asset_id(value: &str) -> Result<String> {
    let id = value
        .strip_prefix("workspace:")
        .ok_or("INVALID_ARGUMENT: id must identify a workspace asset")?;
    let uuid =
        uuid::Uuid::parse_str(id).map_err(|_| "INVALID_ARGUMENT: Asset id must contain a UUID")?;
    Ok(uuid.to_string())
}

fn asset_directory(root: &Path, kind: &str, id: &str) -> Result<PathBuf> {
    safe_dir(&library(root, kind)?.join(asset_id(id)?), false)
}

fn name(params: &Value, fallback: &str) -> Result<String> {
    let name = params
        .get("name")
        .map(|_| required(params, "name"))
        .transpose()?
        .unwrap_or(fallback)
        .trim();
    if name.is_empty() || name.len() > 200 {
        return Err("INVALID_ARGUMENT: name must contain 1..200 bytes".into());
    }
    Ok(name.into())
}

fn extension(path: &Path) -> Result<String> {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("cube")
        .to_ascii_lowercase();
    if !["cube", "3dl", "png", "jpg", "jpeg", "tiff"].contains(&extension.as_str()) {
        return Err("INVALID_LUT: Unsupported LUT extension".into());
    }
    Ok(extension)
}

fn lut_asset(path: &Path) -> Result<LutAsset> {
    let extension = extension(path)?;
    let bytes = bounded_read(path)?;
    crate::lut_processing::parse_lut_file(path.to_string_lossy().as_ref())
        .map_err(|e| format!("INVALID_LUT: {e}"))?;
    Ok(LutAsset {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        extension,
        sha256: hex::encode(Sha256::digest(&bytes)),
        data_base64: STANDARD.encode(bytes),
    })
}

fn materialize_asset(asset: &LutAsset, directory: &Path) -> Result<PathBuf> {
    if !["cube", "3dl", "png", "jpg", "jpeg", "tiff"].contains(&asset.extension.as_str()) {
        return Err("INVALID_LUT: Unsupported embedded LUT extension".into());
    }
    if asset.data_base64.len() > MAX_FILE_BYTES as usize * 4 / 3 + 8 {
        return Err("INVALID_LUT: Embedded LUT exceeds 128 MiB".into());
    }
    let bytes = STANDARD
        .decode(&asset.data_base64)
        .map_err(|_| "INVALID_LUT: Invalid base64")?;
    if bytes.len() > MAX_FILE_BYTES as usize || hex::encode(Sha256::digest(&bytes)) != asset.sha256
    {
        return Err("ASSET_INTEGRITY: Embedded LUT SHA-256 mismatch".into());
    }
    let path = directory.join(format!("lut.{}", asset.extension));
    atomic_write(&path, &bytes, false)?;
    crate::lut_processing::parse_lut_file(path.to_string_lossy().as_ref())
        .map_err(|e| format!("INVALID_LUT: {e}"))?;
    Ok(path)
}

fn read_preset(directory: &Path) -> Result<PresetEnvelope> {
    let envelope: PresetEnvelope =
        serde_json::from_slice(&bounded_read(&directory.join("preset.json"))?)
            .map_err(|e| format!("INVALID_PRESET: {e}"))?;
    if envelope.format != "rapidraw-owned-preset"
        || envelope.version != 1
        || directory.file_name().and_then(|s| s.to_str())
            != Some(asset_id(&envelope.preset.id)?.as_str())
    {
        return Err("INVALID_PRESET: Invalid preset identity or version".into());
    }
    validation::validate_adjustments(&envelope.preset.adjustments, envelope.dimensions)?;
    if let Some(path) = envelope.preset.adjustments["lutPath"].as_str() {
        let path = Path::new(path);
        if path.parent() != Some(directory) {
            return Err("INVALID_PRESET: LUT must belong to its preset directory".into());
        }
        let bytes = bounded_read(path)?;
        if envelope
            .lut
            .as_ref()
            .is_none_or(|asset| asset.sha256 != hex::encode(Sha256::digest(&bytes)))
        {
            return Err("ASSET_INTEGRITY: Preset LUT digest mismatch".into());
        }
    }
    Ok(envelope)
}

fn store_preset(root: &Path, mut envelope: PresetEnvelope) -> Result<Value> {
    validation::validate_adjustments(&envelope.preset.adjustments, envelope.dimensions)?;
    let parent = library(root, "presets")?;
    let id = uuid::Uuid::new_v4().to_string();
    let destination = parent.join(&id);
    let stage = tempfile::Builder::new()
        .prefix(".preset-")
        .tempdir_in(&parent)
        .map_err(|e| e.to_string())?;
    if let Some(asset) = &envelope.lut {
        let materialized = materialize_asset(asset, stage.path())?;
        envelope.preset.adjustments["lutPath"] =
            json!(destination.join(materialized.file_name().unwrap()));
    } else if envelope.preset.adjustments["lutPath"].as_str().is_some() {
        return Err("INVALID_PRESET: Missing LUT dependency".into());
    }
    envelope.format = "rapidraw-owned-preset".into();
    envelope.version = 1;
    envelope.preset.id = format!("workspace:{id}");
    let bytes = serde_json::to_vec_pretty(&envelope).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("INVALID_PRESET: Self-contained preset exceeds 128 MiB".into());
    }
    atomic_write(&stage.path().join("preset.json"), &bytes, false)?;
    fs::rename(stage.path(), &destination).map_err(|e| e.to_string())?;
    Ok(
        json!({"id":envelope.preset.id,"name":envelope.preset.name,"path":destination.join("preset.json"),"dimensions":envelope.dimensions,"owned":true,"lut_preserved":envelope.lut.is_some()}),
    )
}

fn read_lut(directory: &Path) -> Result<StoredLut> {
    let lut: StoredLut = serde_json::from_slice(&bounded_read(&directory.join("entry.json"))?)
        .map_err(|e| format!("INVALID_LUT: {e}"))?;
    if directory.file_name().and_then(|s| s.to_str()) != Some(asset_id(&lut.id)?.as_str())
        || !lut.filename.starts_with("lut.")
        || lut.filename.contains('/')
        || lut.filename.contains('\\')
    {
        return Err("INVALID_LUT: Invalid library identity".into());
    }
    extension(Path::new(&lut.filename))?;
    let bytes = bounded_read(&directory.join(&lut.filename))?;
    if hex::encode(Sha256::digest(&bytes)) != lut.sha256 {
        return Err("ASSET_INTEGRITY: LUT digest mismatch".into());
    }
    Ok(lut)
}

fn directories(root: &Path, kind: &str) -> Result<Vec<PathBuf>> {
    let parent = library(root, kind)?;
    let mut output = Vec::new();
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if uuid::Uuid::parse_str(entry.file_name().to_string_lossy().as_ref()).is_err() {
            return Err("INVALID_ASSET: Unexpected library directory".into());
        }
        output.push(safe_dir(&entry.path(), false)?);
    }
    output.sort();
    Ok(output)
}

fn decode_presets(
    source: &Path,
    value: Value,
    params: &Value,
) -> Result<(Vec<PresetEnvelope>, bool)> {
    if value["format"] == "rapidraw-owned-preset" {
        let envelope: PresetEnvelope =
            serde_json::from_value(value).map_err(|e| format!("INVALID_PRESET: {e}"))?;
        if envelope.version != 1 {
            return Err("INVALID_PRESET: Unsupported preset version".into());
        }
        return Ok((vec![envelope], false));
    }
    let collection = value.get("presets").is_some();
    let presets = if collection {
        let file: PresetFile =
            serde_json::from_value(value).map_err(|e| format!("INVALID_PRESET: {e}"))?;
        let mut presets = Vec::new();
        for item in file.presets {
            match item {
                PresetItem::Preset(preset) => presets.push(preset),
                PresetItem::Folder(folder) => presets.extend(folder.children),
            }
        }
        if presets.is_empty() || presets.len() > 1000 {
            return Err("INVALID_PRESET: Collection must contain 1..1000 presets".into());
        }
        presets
    } else if value.get("adjustments").is_some() {
        vec![serde_json::from_value(value).map_err(|e| format!("INVALID_PRESET: {e}"))?]
    } else {
        vec![Preset {
            id: String::new(),
            name: name(
                params,
                source
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Imported preset"),
            )?,
            adjustments: value,
            include_masks: None,
            include_crop_transform: None,
            preset_type: Some("style".into()),
        }]
    };
    let mut envelopes = Vec::new();
    for preset in presets {
        let lut = preset.adjustments["lutPath"]
            .as_str()
            .map(|path| {
                let path = Path::new(path);
                let path = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    source.parent().unwrap_or(Path::new(".")).join(path)
                };
                lut_asset(&path)
            })
            .transpose()?;
        envelopes.push(PresetEnvelope {
            format: "rapidraw-owned-preset".into(),
            version: 1,
            preset,
            dimensions: (100_000, 100_000),
            lut,
        });
    }
    Ok((envelopes, collection))
}

fn preset_geometry_key(key: &str) -> bool {
    crate::cache_utils::GEOMETRY_KEYS.contains(&key)
        || [
            "crop",
            "rotation",
            "orientationSteps",
            "flipHorizontal",
            "flipVertical",
            "aspectRatio",
            "lensCorrectionMode",
            "lensBlurDepthMap",
            "lensBlurEnabled",
        ]
        .contains(&key)
}

fn select_preset_adjustments(source: &Value, params: &Value) -> Result<Value> {
    let include_masks = flag(params, "include_masks", false)?;
    let include_geometry = flag(params, "include_geometry", false)?;
    let excluded = |key: &str| {
        (!include_masks && ["masks", "aiPatches"].contains(&key))
            || (!include_geometry && preset_geometry_key(key))
    };
    let source = source
        .as_object()
        .ok_or("INVALID_PRESET: Adjustment object missing")?;
    let Some(keys) = params.get("adjustment_keys") else {
        let mut selected = source.clone();
        selected.retain(|key, _| !excluded(key));
        return Ok(Value::Object(selected));
    };
    let keys = keys
        .as_array()
        .filter(|keys| !keys.is_empty() && keys.len() <= 100)
        .ok_or("INVALID_ARGUMENT: adjustment_keys must contain 1..100 unique top-level adjustment names")?;
    let schema = validation::adjustment_schema();
    let known = schema["properties"].as_object().unwrap();
    let mut seen = HashSet::new();
    let mut selected = serde_json::Map::new();
    for key in keys {
        let key = key
            .as_str()
            .ok_or("INVALID_ARGUMENT: adjustment_keys must contain strings")?;
        if !known.contains_key(key) {
            return Err(format!("INVALID_ARGUMENT: Unknown adjustment key {key}"));
        }
        if !seen.insert(key) {
            return Err(format!("INVALID_ARGUMENT: Duplicate adjustment key {key}"));
        }
        if excluded(key) {
            return Err(format!(
                "INVALID_ARGUMENT: Adjustment {key} is excluded by include_masks/include_geometry; enable its option explicitly or omit the key"
            ));
        }
        let value = source
            .get(key)
            .ok_or_else(|| format!("INVALID_PRESET: Requested adjustment {key} is missing"))?;
        selected.insert(key.to_owned(), value.clone());
    }
    // A LUT's input interpretation and strength belong to the same saved look.
    // UI metadata alone must not accidentally reuse a target image's LUT.
    if selected.keys().any(|key| key.starts_with("lut")) {
        for key in ["lutPath", "lutIntensity", "lutIsSceneReferred"] {
            if !selected.contains_key(key) {
                return Err(format!(
                    "INVALID_ARGUMENT: LUT selection requires lutPath, lutIntensity and lutIsSceneReferred together; missing {key}"
                ));
            }
        }
    }
    // Saved native curves are authoritative, including when point controls
    // retain older values from before a switch to parametric editing.
    if ["pointCurves", "parametricCurve", "curveMode"]
        .iter()
        .any(|key| selected.contains_key(*key))
        && !selected.contains_key("curves")
    {
        return Err(
            "INVALID_ARGUMENT: Selecting curve controls also requires curves to preserve the rendered result".into(),
        );
    }
    Ok(Value::Object(selected))
}

impl Bridge {
    pub(super) fn workspace_presets(&self) -> Result<Vec<Preset>> {
        directories(&self.paths.root, "presets")?
            .iter()
            .map(|directory| read_preset(directory).map(|p| p.preset))
            .collect()
    }

    pub(super) fn workspace_luts(&self) -> Result<Vec<LutEntry>> {
        directories(&self.paths.root, "luts")?
            .iter()
            .map(|directory| {
                let lut = read_lut(directory)?;
                Ok(LutEntry {
                    name: lut.name,
                    path: directory.join(lut.filename).to_string_lossy().into_owned(),
                    is_built_in: false,
                })
            })
            .collect()
    }

    pub(super) fn manage_presets(&self, params: &Value) -> Result<Value> {
        let action = required(params, "action")?;
        if action != "save" && params.get("adjustment_keys").is_some() {
            return Err(
                "INVALID_ARGUMENT: adjustment_keys is only supported for action save".into(),
            );
        }
        match action {
            "list" => Ok(json!({"presets":self.workspace_presets()?,"scope":"workspace"})),
            "save" => {
                let session = self.session(params)?;
                session.check_revision(params)?;
                let include_masks = flag(params, "include_masks", false)?;
                let include_geometry = flag(params, "include_geometry", false)?;
                let adjustments =
                    select_preset_adjustments(&session.current().adjustments, params)?;
                let adjustment_keys = adjustments
                    .as_object()
                    .unwrap()
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>();
                let asset = adjustments["lutPath"]
                    .as_str()
                    .map(|p| lut_asset(Path::new(p)))
                    .transpose()?;
                let preset = Preset {
                    id: String::new(),
                    name: name(params, "Agent preset")?,
                    adjustments,
                    include_masks: Some(include_masks),
                    include_crop_transform: Some(include_geometry),
                    preset_type: Some("style".into()),
                };
                let mut result = store_preset(
                    &self.paths.root,
                    PresetEnvelope {
                        format: "rapidraw-owned-preset".into(),
                        version: 1,
                        preset,
                        dimensions: session.dimensions,
                        lut: asset,
                    },
                )?;
                result["adjustment_keys"] = json!(adjustment_keys);
                Ok(result)
            }
            "import" => {
                let source = Path::new(required(params, "path")?);
                let value: Value = serde_json::from_slice(&bounded_read(source)?)
                    .map_err(|e| format!("INVALID_PRESET: {e}"))?;
                let (envelopes, collection) = decode_presets(source, value, params)?;
                let mut results = Vec::new();
                for mut envelope in envelopes {
                    let original_name = envelope.preset.name.clone();
                    let outcome = (|| -> Result<Value> {
                        let warnings = super::operations::migrate_legacy_preset(
                            &mut envelope.preset.adjustments,
                        )?;
                        envelope.preset.name = name(params, &envelope.preset.name)?;
                        let mut result = store_preset(&self.paths.root, envelope)?;
                        result["ok"] = json!(true);
                        if !warnings.is_empty() {
                            result["warnings"] = json!(warnings);
                        }
                        Ok(result)
                    })();
                    if !collection {
                        return outcome;
                    }
                    results.push(match outcome {
                        Ok(value) => value,
                        Err(error) => json!({"name":original_name,"ok":false,"error":error}),
                    });
                }
                let failed = results.iter().filter(|v| v["ok"] == false).count();
                Ok(
                    json!({"results":results,"succeeded":results.len()-failed,"failed":failed,"folders_flattened":true}),
                )
            }
            "export" => {
                let directory =
                    asset_directory(&self.paths.root, "presets", required(params, "id")?)?;
                let mut envelope = read_preset(&directory)?;
                if let Some(asset) = &envelope.lut {
                    envelope.preset.adjustments["lutPath"] =
                        json!(format!("embedded:{}.{}", asset.sha256, asset.extension));
                }
                let path = self.output_path(required(params, "path")?, "exports")?;
                atomic_write(
                    &path,
                    &serde_json::to_vec_pretty(&envelope).map_err(|e| e.to_string())?,
                    false,
                )?;
                Ok(
                    json!({"path":path,"id":envelope.preset.id,"self_contained":true,"lut_preserved":envelope.lut.is_some()}),
                )
            }
            "remove" => {
                let id = required(params, "id")?;
                let directory = asset_directory(&self.paths.root, "presets", id)?;
                read_preset(&directory)?;
                fs::remove_dir_all(directory).map_err(|e| e.to_string())?;
                Ok(json!({"id":id,"removed":true,"scope":"workspace","sessions_preserved":true}))
            }
            _ => Err("INVALID_ARGUMENT: Unknown preset action".into()),
        }
    }

    pub(super) fn manage_luts(&self, params: &Value) -> Result<Value> {
        match required(params, "action")? {
            "list" => {
                let mut entries = Vec::new();
                for directory in directories(&self.paths.root, "luts")? {
                    let lut = read_lut(&directory)?;
                    entries.push(json!({"id":lut.id,"name":lut.name,"path":directory.join(lut.filename),"sha256":lut.sha256,"owned":true}));
                }
                Ok(json!({"luts":entries,"scope":"workspace"}))
            }
            "import" => {
                let source = Path::new(required(params, "path")?);
                let asset = lut_asset(source)?;
                let parent = library(&self.paths.root, "luts")?;
                let id = uuid::Uuid::new_v4().to_string();
                let destination = parent.join(&id);
                let stage = tempfile::Builder::new()
                    .prefix(".lut-")
                    .tempdir_in(parent)
                    .map_err(|e| e.to_string())?;
                let path = materialize_asset(&asset, stage.path())?;
                let lut = StoredLut {
                    id: format!("workspace:{id}"),
                    name: name(
                        params,
                        source
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("Imported LUT"),
                    )?,
                    filename: path.file_name().unwrap().to_string_lossy().into_owned(),
                    sha256: asset.sha256,
                };
                atomic_write(
                    &stage.path().join("entry.json"),
                    &serde_json::to_vec_pretty(&lut).map_err(|e| e.to_string())?,
                    false,
                )?;
                fs::rename(stage.path(), &destination).map_err(|e| e.to_string())?;
                Ok(
                    json!({"id":lut.id,"name":lut.name,"path":destination.join(lut.filename),"sha256":lut.sha256,"owned":true}),
                )
            }
            "export" => {
                let directory = asset_directory(&self.paths.root, "luts", required(params, "id")?)?;
                let lut = read_lut(&directory)?;
                let path = self.output_path(required(params, "path")?, "exports")?;
                if extension(&path)? != extension(Path::new(&lut.filename))? {
                    return Err(
                        "INVALID_ARGUMENT: LUT export extension must match the source format"
                            .into(),
                    );
                }
                atomic_write(&path, &bounded_read(&directory.join(lut.filename))?, false)?;
                Ok(json!({"path":path,"id":lut.id,"sha256":lut.sha256}))
            }
            "remove" => {
                let id = required(params, "id")?;
                let directory = asset_directory(&self.paths.root, "luts", id)?;
                read_lut(&directory)?;
                fs::remove_dir_all(directory).map_err(|e| e.to_string())?;
                Ok(json!({"id":id,"removed":true,"scope":"workspace","sessions_preserved":true}))
            }
            _ => Err("INVALID_ARGUMENT: Unknown LUT action".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity(root: &Path) -> PathBuf {
        let path = root.join("identity.cube");
        fs::write(
            &path,
            "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n",
        )
        .unwrap();
        path
    }

    #[test]
    fn selected_preset_keys_reject_ambiguous_or_excluded_requests() {
        let source = validation::default_adjustments();
        for (keys, message) in [
            (json!([]), "1..100"),
            (json!("contrast"), "1..100"),
            (json!([1]), "strings"),
            (json!(["contrast", "contrast"]), "Duplicate"),
            (json!(["notAnAdjustment"]), "Unknown"),
            (json!(["hsl.reds.saturation"]), "Unknown"),
            (json!(["masks"]), "excluded"),
            (json!(["aiPatches"]), "excluded"),
            (json!(["crop"]), "excluded"),
            (json!(["lensBlurDepthMap"]), "excluded"),
            (json!(["lutPath", "lutIntensity"]), "lutIsSceneReferred"),
            (json!(["lutName"]), "lutPath"),
            (json!(["pointCurves", "curveMode"]), "requires curves"),
        ] {
            let error =
                select_preset_adjustments(&source, &json!({"adjustment_keys":keys})).unwrap_err();
            assert!(error.contains(message), "{keys}: {error}");
        }
        let mut missing = source.clone();
        missing.as_object_mut().unwrap().remove("contrast");
        assert!(
            select_preset_adjustments(&missing, &json!({"adjustment_keys":["contrast"]}))
                .unwrap_err()
                .contains("missing")
        );
        let explicit = select_preset_adjustments(
            &source,
            &json!({"adjustment_keys":["masks","crop"],"include_masks":true,"include_geometry":true}),
        )
        .unwrap();
        assert_eq!(explicit.as_object().unwrap().len(), 2);
        let legacy_save = select_preset_adjustments(&source, &json!({})).unwrap();
        assert_eq!(legacy_save["exposure"], source["exposure"]);
        for key in ["masks", "aiPatches", "crop", "lensBlurDepthMap"] {
            assert!(legacy_save.get(key).is_none(), "{key}");
        }
    }

    #[test]
    fn selected_curves_keep_rendered_values_when_ui_controls_are_stale() {
        let mut source = validation::default_adjustments();
        source["curveMode"] = json!("parametric");
        source["parametricCurve"]["luma"]["lights"] = json!(45);
        source["curves"]["luma"] = json!([{"x":0,"y":3},{"x":128,"y":140},{"x":255,"y":250}]);
        let selected = select_preset_adjustments(
            &source,
            &json!({"adjustment_keys":["curves","pointCurves","parametricCurve","curveMode"]}),
        )
        .unwrap();
        let mut target = validation::default_adjustments();
        validation::merge_patch(&mut target, &selected).unwrap();
        assert_eq!(target["curves"], source["curves"]);
        assert_eq!(target["curveMode"], "parametric");
        let mut compiled = source.clone();
        validation::resolve_curves(&mut compiled);
        assert_ne!(target["curves"], compiled["curves"]);
    }

    #[test]
    fn selected_film_preset_round_trip_preserves_target_base_corrections() {
        let origin = tempfile::tempdir().unwrap();
        let root = origin.path().canonicalize().unwrap();
        let lut = identity(&root);
        let mut source = validation::default_adjustments();
        source["lutPath"] = json!(lut);
        source["lutIntensity"] = json!(65);
        source["lutIsSceneReferred"] = json!(true);
        source["contrast"] = json!(-4);
        source["curves"]["luma"] = json!([{"x":0,"y":3},{"x":128,"y":130},{"x":255,"y":250}]);
        let selected = select_preset_adjustments(
            &source,
            &json!({"adjustment_keys":["lutPath","lutIntensity","lutIsSceneReferred","contrast","curves"]}),
        )
        .unwrap();
        let saved = store_preset(
            &root,
            PresetEnvelope {
                format: "rapidraw-owned-preset".into(),
                version: 1,
                dimensions: (20, 20),
                lut: Some(lut_asset(&lut).unwrap()),
                preset: Preset {
                    id: String::new(),
                    name: "Selective film".into(),
                    adjustments: selected,
                    include_masks: Some(false),
                    include_crop_transform: Some(false),
                    preset_type: Some("style".into()),
                },
            },
        )
        .unwrap();
        let directory = asset_directory(&root, "presets", saved["id"].as_str().unwrap()).unwrap();
        let mut exported = read_preset(&directory).unwrap();
        let asset = exported.lut.as_ref().unwrap();
        exported.preset.adjustments["lutPath"] =
            json!(format!("embedded:{}.{}", asset.sha256, asset.extension));
        let transport = serde_json::to_value(exported).unwrap();
        let (mut decoded, collection) =
            decode_presets(&root.join("film.json"), transport, &json!({})).unwrap();
        assert!(!collection);
        drop(origin);
        let destination = tempfile::tempdir().unwrap();
        let destination_root = destination.path().canonicalize().unwrap();
        let imported = store_preset(&destination_root, decoded.remove(0)).unwrap();
        let directory = asset_directory(
            &destination_root,
            "presets",
            imported["id"].as_str().unwrap(),
        )
        .unwrap();
        let preset = read_preset(&directory).unwrap().preset;
        assert_eq!(preset.adjustments.as_object().unwrap().len(), 5);
        let corrections = json!({"exposure":1.1,"temperature":7,"tint":-4,"colorNoiseReduction":30,"lumaNoiseReduction":12,"sharpness":40});
        let mut target = validation::default_adjustments();
        validation::merge_patch(&mut target, &corrections).unwrap();
        validation::merge_patch(&mut target, &preset.adjustments).unwrap();
        validation::validate_adjustments(&target, (40, 30)).unwrap();
        for (key, value) in corrections.as_object().unwrap() {
            assert_eq!(&target[key], value, "base correction {key} changed");
        }
        assert_eq!(target["lutIsSceneReferred"], true);
        assert_eq!(target["lutIntensity"], 65);
        assert_eq!(target["contrast"], -4);
        assert_eq!(target["curves"], source["curves"]);
        assert!(Path::new(target["lutPath"].as_str().unwrap()).starts_with(&directory));
    }

    #[test]
    fn stored_preset_owns_lut_after_original_is_removed() {
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let source = identity(&root_path);
        let asset = lut_asset(&source).unwrap();
        let mut adjustments = validation::default_adjustments();
        adjustments["lutPath"] = json!(source);
        let envelope = PresetEnvelope {
            format: "rapidraw-owned-preset".into(),
            version: 1,
            dimensions: (20, 20),
            lut: Some(asset),
            preset: Preset {
                id: String::new(),
                name: "Reusable look".into(),
                adjustments,
                include_masks: Some(false),
                include_crop_transform: Some(false),
                preset_type: Some("style".into()),
            },
        };
        let saved = store_preset(&root_path, envelope).unwrap();
        fs::remove_file(&source).unwrap();
        let directory =
            asset_directory(&root_path, "presets", saved["id"].as_str().unwrap()).unwrap();
        let stored = read_preset(&directory).unwrap();
        let path = Path::new(stored.preset.adjustments["lutPath"].as_str().unwrap());
        assert!(path.starts_with(&directory));
        assert!(crate::lut_processing::parse_lut_file(path.to_str().unwrap()).is_ok());
        // The in-memory exported envelope includes verified bytes, so it can be
        // reimported into a completely different workspace independently.
        let target = tempfile::tempdir().unwrap();
        let imported = store_preset(&target.path().canonicalize().unwrap(), stored).unwrap();
        assert_ne!(saved["id"], imported["id"]);
        drop(root);
        let target_directory = asset_directory(
            &target.path().canonicalize().unwrap(),
            "presets",
            imported["id"].as_str().unwrap(),
        )
        .unwrap();
        assert!(read_preset(&target_directory).is_ok());
    }
    #[test]
    fn native_preset_collections_flatten_folders_and_retain_selection_flags() {
        let root = tempfile::tempdir().unwrap();
        let value = json!({"creator":"RapidRAW","presets":[
            {"preset":{"id":"old-1","name":"Basic","adjustments":{"exposure":0.4},"includeMasks":false,"includeCropTransform":false}},
            {"folder":{"id":"folder","name":"Collection","children":[{"id":"old-2","name":"Warm","adjustments":{"temperature":8}}]}}
        ]});
        let (envelopes, collection) =
            decode_presets(&root.path().join("export.rrpreset"), value, &json!({})).unwrap();
        assert!(collection);
        assert_eq!(envelopes.len(), 2);
        assert_eq!(envelopes[0].preset.include_masks, Some(false));
        assert_eq!(envelopes[0].preset.include_crop_transform, Some(false));
        assert_eq!(envelopes[1].preset.name, "Warm");
        let first =
            store_preset(&root.path().canonicalize().unwrap(), envelopes[0].clone()).unwrap();
        let second =
            store_preset(&root.path().canonicalize().unwrap(), envelopes[1].clone()).unwrap();
        assert_ne!(first["id"], second["id"]);
    }

    #[test]
    fn embedded_lut_hashes_and_asset_scope_are_enforced() {
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let source = identity(&root_path);
        let mut asset = lut_asset(&source).unwrap();
        asset.sha256 = "0".repeat(64);
        assert!(
            materialize_asset(&asset, &root_path)
                .unwrap_err()
                .contains("SHA-256")
        );
        for id in [
            "installed-id",
            "workspace:../outside",
            "workspace:/root",
            "workspace:not-a-uuid",
        ] {
            assert!(asset_id(id).is_err());
        }
        #[cfg(unix)]
        {
            let external = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(external.path(), root_path.join("assets")).unwrap();
            assert!(
                library(&root_path, "presets")
                    .unwrap_err()
                    .contains("symlink")
            );
            assert!(fs::read_dir(external.path()).unwrap().next().is_none());
        }
    }
}
