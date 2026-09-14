//! Local learned masks and photographic restoration shared by desktop and MCP.
pub mod desktop;
pub mod integration;
pub mod masking;
pub mod restoration;
mod runtime;

use anyhow::{Result, anyhow, bail};
use image::{DynamicImage, GrayImage};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    Fast,
    #[default]
    Balanced,
    Quality,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    RefineMask,
    SemanticMask,
    Deblur,
    Upscale,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Domain {
    #[default]
    Landscape,
    Face,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub operation: Operation,
    #[serde(default)]
    pub profile: Profile,
    #[serde(default)]
    pub provider: runtime::Provider,
    #[serde(default)]
    pub domain: Domain,
    #[serde(default)]
    pub classes: Vec<String>,
    #[serde(default = "default_strength")]
    pub strength: f32,
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    #[serde(default = "default_radius")]
    pub boundary_radius: u32,
    #[serde(default)]
    pub region: Option<[u32; 4]>,
}
fn default_strength() -> f32 {
    1.0
}
fn default_confidence() -> f32 {
    0.5
}
fn default_radius() -> u32 {
    32
}

pub struct Output {
    pub image: Option<DynamicImage>,
    pub mask: Option<GrayImage>,
    pub receipt: Value,
}

pub struct Model {
    pub id: &'static str,
    pub filename: &'static str,
    pub label: &'static str,
    pub license: &'static str,
    pub source: &'static str,
    pub url: Option<&'static str>,
    pub sha256: Option<&'static str>,
}

pub const MODELS: &[Model] = &[
    Model {
        id: "matting",
        filename: "vitmatte-small-f32.onnx",
        label: "ViTMatte Small",
        license: "Apache-2.0 checkpoint / MIT upstream",
        source: "https://huggingface.co/hustvl/vitmatte-small-composition-1k",
        url: Some(
            "https://huggingface.co/Xenova/vitmatte-small-composition-1k/resolve/6bc1297f6140f055a227b6d2cfe8c093281f35d2/onnx/model.onnx",
        ),
        sha256: Some("bf28d2e0be2c073286e88d60ad649d7123da2749a2d99133fd1098d5887e0225"),
    },
    Model {
        id: "face",
        filename: "face-parsing-resnet18.onnx",
        label: "Face Parsing ResNet18",
        license: "MIT",
        source: "https://github.com/yakhyo/face-parsing",
        url: Some("https://github.com/yakhyo/face-parsing/releases/download/weights/resnet18.onnx"),
        sha256: Some("0d9bd318e46987c3bdbfacae9e2c0f461cae1c6ac6ea6d43bbe541a91727e33f"),
    },
    Model {
        id: "landscape",
        filename: "upernet-convnext-tiny.onnx",
        label: "UperNet ConvNeXt Tiny",
        license: "MIT",
        source: "https://huggingface.co/openmmlab/upernet-convnext-tiny",
        url: None,
        sha256: None,
    },
    Model {
        id: "deblur",
        filename: "nafnet_gopro_w32.onnx",
        label: "NAFNet GoPro 32",
        license: "MIT",
        source: "https://github.com/megvii-research/NAFNet",
        url: None,
        sha256: None,
    },
    Model {
        id: "upscale",
        filename: "swinir_lightweight_x2.onnx",
        label: "SwinIR Lightweight 2x",
        license: "Apache-2.0",
        source: "https://github.com/JingyunLiang/SwinIR",
        url: None,
        sha256: None,
    },
];

pub fn model(id: &str) -> Result<&'static Model> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: Unknown enhancement model {id}"))
}

impl Request {
    pub fn model_id(&self) -> &'static str {
        match self.operation {
            Operation::RefineMask => "matting",
            Operation::SemanticMask => {
                if self.domain == Domain::Face {
                    "face"
                } else {
                    "landscape"
                }
            }
            Operation::Deblur => "deblur",
            Operation::Upscale => "upscale",
        }
    }
    pub fn validate(&self, dimensions: (u32, u32)) -> Result<()> {
        if dimensions.0 == 0
            || dimensions.1 == 0
            || u64::from(dimensions.0) * u64::from(dimensions.1) > 100_000_000
        {
            bail!("IMAGE_LIMIT: Enhancement input must be nonempty and at most 100 megapixels");
        }
        if !self.strength.is_finite()
            || !(0.0..=1.0).contains(&self.strength)
            || !self.confidence.is_finite()
            || !(0.0..=1.0).contains(&self.confidence)
        {
            bail!("INVALID_ARGUMENT: strength and confidence must be finite numbers in 0..1");
        }
        if self.operation != Operation::SemanticMask && !self.classes.is_empty() {
            bail!("INVALID_ARGUMENT: classes only apply to semantic masks");
        }
        if !(1..=256).contains(&self.boundary_radius) {
            bail!("INVALID_ARGUMENT: boundary_radius must be 1..256 source pixels");
        }
        if self.operation == Operation::SemanticMask
            && (self.classes.is_empty()
                || self.classes.len() > 32
                || self.classes.iter().any(|s| s.is_empty() || s.len() > 80))
        {
            bail!("INVALID_ARGUMENT: Semantic masks require 1..32 supported class names");
        }
        if let Some([x, y, w, h]) = self.region
            && (w == 0
                || h == 0
                || x.checked_add(w).is_none_or(|v| v > dimensions.0)
                || y.checked_add(h).is_none_or(|v| v > dimensions.1))
        {
            bail!("INVALID_ARGUMENT: region must fit within the image");
        }
        let (_, _, w, h) = self.region.map(|[x, y, w, h]| (x, y, w, h)).unwrap_or((
            0,
            0,
            dimensions.0,
            dimensions.1,
        ));
        if self.operation == Operation::Upscale && u64::from(w) * u64::from(h) * 4 > 100_000_000 {
            bail!("IMAGE_LIMIT: 2x enhancement would exceed 100 megapixels; select a smaller crop");
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Installed {
    model_id: String,
    sha256: String,
    bytes: u64,
}

pub fn digest(path: &Path) -> Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 131072];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}
fn manifest_path(directory: &Path, m: &Model) -> PathBuf {
    directory.join(format!("{}.json", m.filename))
}
fn regular(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("INVALID_MODEL: Model assets must be regular files");
    }
    Ok(())
}

// Keep the lock file in place: replacing it would allow two processes to lock
// different inodes while publishing or loading the same model paths.
fn lock_models(directory: &Path) -> Result<fs::File> {
    let path = directory.join(".enhancement-models.lock");
    let metadata = fs::symlink_metadata(directory).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            anyhow!("MODEL_NOT_INSTALLED: Install enhancement models first")
        } else {
            error.into()
        }
    })?;
    if metadata.file_type().is_symlink() || fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file())
    {
        bail!("INVALID_PATH: Model directory and lock cannot be symlinks");
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    lock.try_lock().map_err(|e| {
        anyhow!("ENHANCEMENT_MODELS_BUSY: Model installation, verification or inference is active ({e}); retry after it finishes")
    })?;
    Ok(lock)
}

pub fn installed(directory: &Path, id: &str) -> Result<(PathBuf, String)> {
    model(id)?;
    let _model_lock = lock_models(directory)?;
    installed_unlocked(directory, id)
}

fn installed_unlocked(directory: &Path, id: &str) -> Result<(PathBuf, String)> {
    let m = model(id)?;
    let path = directory.join(m.filename);
    regular(&path)
        .map_err(|_| anyhow!("MODEL_NOT_INSTALLED: Install enhancement model '{id}' first"))?;
    let expected = if let Some(hash) = m.sha256 {
        hash.to_string()
    } else {
        let receipt = manifest_path(directory, m);
        regular(&receipt)?;
        if fs::metadata(&receipt)?.len() > 4096 {
            bail!("INVALID_MODEL: Installation receipt is too large");
        }
        let data: Installed = serde_json::from_slice(&fs::read(receipt)?)?;
        if data.model_id != id
            || !valid_hash(&data.sha256)
            || data.bytes != fs::metadata(&path)?.len()
        {
            bail!("INVALID_MODEL: Model installation receipt does not match");
        }
        data.sha256
    };
    if digest(&path)? != expected {
        bail!("MODEL_CHANGED: Enhancement model '{id}' failed SHA-256 verification");
    }
    Ok((path, expected))
}

pub fn status(directory: &Path) -> Value {
    json!({"models":MODELS.iter().map(|m| {
        let ready=installed(directory,m.id);
        json!({"id":m.id,"name":m.label,"filename":m.filename,"path":directory.join(m.filename),"license":m.license,"source":m.source,"download_available":m.url.is_some(),"ready":ready.is_ok(),"sha256":ready.as_ref().ok().map(|(_,h)|h),"error":ready.err().map(|e|e.to_string()),"coreml_supported":m.id=="matting"})
    }).collect::<Vec<_>>(),"profiles":["fast","balanced","quality"],"providers":runtime::providers(),"semantic_categories":{"landscape":masking::LANDSCAPE_CATEGORIES,"face":masking::FACE_CATEGORIES},"restoration_domain":"Rendered sRGB; produces a separate image with the parent edits baked in","runtime":runtime::status()})
}

pub async fn install(
    directory: &Path,
    id: &str,
    source: Option<&Path>,
    expected: Option<&str>,
) -> Result<Value> {
    let m = model(id)?;
    fs::create_dir_all(directory)?;
    if fs::symlink_metadata(directory)?.file_type().is_symlink() {
        bail!("INVALID_PATH: Model directory cannot be a symlink");
    }
    let expected=m.sha256.or(expected).ok_or_else(||anyhow!("MODEL_PREPARATION_REQUIRED: Prepare {id} with the repository exporter, then import its ONNX path and SHA-256"))?;
    if !valid_hash(expected) {
        bail!("INVALID_ARGUMENT: sha256 must contain 64 hexadecimal characters");
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    if let Some(source) = source {
        regular(source)?;
        let temporary_path = temporary.into_temp_path();
        fs::remove_file(&temporary_path)?;
        crate::storage_copy::copy_new(source, &temporary_path)?;
        temporary = tempfile::NamedTempFile::from_parts(
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&temporary_path)?,
            temporary_path,
        );
    } else {
        let url = m.url.ok_or_else(|| {
            anyhow!("MODEL_PREPARATION_REQUIRED: {id} requires a locally prepared ONNX path")
        })?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(900))
            .build()?;
        let mut response = client.get(url).send().await?.error_for_status()?;
        let mut size = 0usize;
        while let Some(chunk) = response.chunk().await? {
            size = size
                .checked_add(chunk.len())
                .ok_or_else(|| anyhow!("MODEL_TOO_LARGE"))?;
            if size > 1_500_000_000 {
                bail!("MODEL_TOO_LARGE: Model exceeds the installation limit");
            }
            temporary.write_all(&chunk)?;
        }
    }
    if temporary.as_file().metadata()?.len() > 1_500_000_000 {
        bail!("MODEL_TOO_LARGE");
    }
    if digest(temporary.path())? != expected.to_ascii_lowercase() {
        bail!("MODEL_HASH_MISMATCH: Model does not match the expected SHA-256");
    }
    temporary.as_file().sync_all()?;
    let bytes = temporary.as_file().metadata()?.len();
    let _model_lock = lock_models(directory)?;
    temporary
        .persist(directory.join(m.filename))
        .map_err(|e| e.error)?;
    let mut receipt = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer_pretty(
        &mut receipt,
        &Installed {
            model_id: id.into(),
            sha256: expected.to_ascii_lowercase(),
            bytes,
        },
    )?;
    receipt.as_file().sync_all()?;
    receipt
        .persist(manifest_path(directory, m))
        .map_err(|e| e.error)?;
    runtime::clear();
    Ok(
        json!({"model_id":id,"installed":true,"sha256":expected,"bytes":bytes,"path":directory.join(m.filename)}),
    )
}

pub fn run(
    directory: &Path,
    image: &DynamicImage,
    mask: Option<&GrayImage>,
    request: &Request,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<Output> {
    if cancel.load(Ordering::Relaxed) {
        bail!("CANCELLED: Enhancement cancelled");
    }
    request.validate((image.width(), image.height()))?;
    let start = Instant::now();
    let _model_lock = lock_models(directory)?;
    let (path, sha256) = installed_unlocked(directory, request.model_id())?;
    if cancel.load(Ordering::Relaxed) {
        bail!("CANCELLED: Enhancement cancelled");
    }
    let mut receipt = json!({"operation":request.operation,"model_id":request.model_id(),"model_sha256":sha256,"profile":request.profile,"input_dimensions":[image.width(),image.height()],"source_region":request.region,"requested_provider":request.provider});
    let (image_out, mask_out, runtime) = runtime::with_session(
        &path,
        &sha256,
        request.provider,
        |session| {
            if cancel.load(Ordering::Relaxed) {
                bail!("CANCELLED: Enhancement cancelled");
            }
            match request.operation {
                Operation::RefineMask => {
                    let coarse = mask.ok_or_else(|| {
                        anyhow!("INVALID_ARGUMENT: Refine mask requires an existing mask")
                    })?;
                    if coarse.dimensions() != (image.width(), image.height()) {
                        bail!("INVALID_ARGUMENT: Mask and photograph dimensions differ");
                    }
                    let (source, selection) = if let Some([x, y, w, h]) = request.region {
                        (
                            image.crop_imm(x, y, w, h),
                            image::imageops::crop_imm(coarse, x, y, w, h).to_image(),
                        )
                    } else {
                        (image.clone(), coarse.clone())
                    };
                    let (edge, tile) = match request.profile {
                        Profile::Fast => (512, 512),
                        Profile::Balanced => (1536, 512),
                        Profile::Quality => (0, 768),
                    };
                    let options = masking::MattingOptions {
                        max_edge: edge,
                        tile_size: tile,
                        overlap: 64,
                        radius: request.boundary_radius,
                    };
                    let (refined, statistics) =
                        masking::refine(session, &source, &selection, &options, cancel, progress)?;
                    if statistics.inferred_tiles == 0 {
                        bail!(
                            "ENHANCEMENT_INSUFFICIENT_CONTEXT: No boundary tile had enough foreground and background context. Try a narrower boundary or Balanced profile; the original mask is unchanged"
                        );
                    }
                    if statistics.coarse_fallback_tiles > 0 {
                        receipt["warnings"] = json!([
                            "Some edges kept the original selection because the model lacked local context. Try a narrower boundary or Balanced profile to refine those areas."
                        ]);
                    }
                    receipt["inferred_tiles"] = json!(statistics.inferred_tiles);
                    receipt["coarse_fallback_tiles"] = json!(statistics.coarse_fallback_tiles);
                    receipt["inference_max_edge"] = json!(edge);
                    receipt["tile_size"] = json!(tile);
                    receipt["boundary_radius"] = json!(request.boundary_radius);
                    let full = if let Some([x, y, _, _]) = request.region {
                        let mut full = coarse.clone();
                        image::imageops::replace(&mut full, &refined, i64::from(x), i64::from(y));
                        full
                    } else {
                        refined
                    };
                    Ok((None, Some(full)))
                }
                Operation::SemanticMask => {
                    let options = masking::SemanticOptions {
                        kind: if request.domain == Domain::Face {
                            masking::SemanticModel::Face
                        } else {
                            masking::SemanticModel::Landscape
                        },
                        classes: request.classes.clone(),
                        confidence: request.confidence,
                        region: request.region,
                    };
                    let mask = masking::semantic(session, image, &options, cancel, progress)?;
                    receipt["inference_dimensions"] = json!([512, 512]);
                    receipt["classes"] = json!(request.classes);
                    receipt["confidence"] = json!(request.confidence);
                    Ok((None, Some(mask)))
                }
                Operation::Deblur | Operation::Upscale => {
                    let source = if let Some([x, y, w, h]) = request.region {
                        image.crop_imm(x, y, w, h)
                    } else {
                        image.clone()
                    };
                    let scale = if request.operation == Operation::Upscale {
                        2
                    } else {
                        1
                    };
                    let (tile, overlap) = match request.profile {
                        Profile::Fast => (128, 16),
                        Profile::Balanced => (256, 32),
                        Profile::Quality => (384, 48),
                    };
                    let options = restoration::RestorationOptions {
                        tile_size: tile,
                        overlap,
                        strength: request.strength,
                        output_scale: scale,
                        max_output_pixels: 100_000_000,
                    };
                    let model = restoration::RestorationModel {
                        scale,
                        input_multiple: if scale == 2 { 8 } else { 16 },
                    };
                    let restored =
                        restoration::restore(session, &source, model, options, cancel, progress)?;
                    receipt["tile_size"] = json!(tile);
                    receipt["overlap"] = json!(overlap);
                    receipt["strength"] = json!(request.strength);
                    receipt["scale"] = json!(scale);
                    receipt["output_dimensions"] = json!([restored.width(), restored.height()]);
                    Ok((Some(restored), None))
                }
            }
        },
    )?;
    if cancel.load(Ordering::Relaxed) {
        bail!("CANCELLED: Enhancement cancelled");
    }
    if let Some(bitmap) = &mask_out {
        receipt["output_dimensions"] = json!([bitmap.width(), bitmap.height()]);
    }
    receipt["runtime"] = runtime;
    receipt["elapsed_ms"] = json!(start.elapsed().as_millis());
    Ok(Output {
        image: image_out,
        mask: mask_out,
        receipt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_geometry_and_allocation_overflow_before_models() {
        let base = json!({"operation":"upscale"});
        let mut req: Request = serde_json::from_value(base).unwrap();
        assert!(req.validate((6960, 4640)).is_err());
        req.region = Some([0, 0, 3000, 2000]);
        assert!(req.validate((6960, 4640)).is_ok());
        req.region = Some([u32::MAX, 0, 2, 2]);
        assert!(req.validate((10, 10)).is_err());
        req.region = None;
        req.strength = f32::NAN;
        assert!(req.validate((10, 10)).is_err());
    }
    #[test]
    fn operation_fields_do_not_silently_accept_typos() {
        assert!(
            serde_json::from_value::<Request>(json!({"operation":"deblur","tile_szie":128}))
                .is_err()
        );
        let req: Request = serde_json::from_value(json!({"operation":"semantic_mask"})).unwrap();
        assert!(req.validate((20, 20)).is_err());
    }

    #[tokio::test]
    async fn model_lock_keeps_verified_file_and_receipt_matched_during_replacement() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("models");
        let first = temporary.path().join("first.onnx");
        let second = temporary.path().join("second.onnx");
        // These fixtures exercise registry publication without loading ONNX.
        fs::write(&first, b"first model bytes").unwrap();
        fs::write(&second, b"other model bytes").unwrap();
        let first_hash = digest(&first).unwrap();
        let second_hash = digest(&second).unwrap();
        install(&directory, "deblur", Some(&first), Some(&first_hash))
            .await
            .unwrap();

        let guard = lock_models(&directory).unwrap();
        let (verified_path, verified_hash) = installed_unlocked(&directory, "deblur").unwrap();
        let worker_directory = directory.clone();
        let worker_source = second.clone();
        let worker_hash = second_hash.clone();
        let replacement = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(install(
                    &worker_directory,
                    "deblur",
                    Some(&worker_source),
                    Some(&worker_hash),
                ))
        })
        .join()
        .unwrap();
        assert!(
            replacement
                .unwrap_err()
                .to_string()
                .starts_with("ENHANCEMENT_MODELS_BUSY:")
        );
        assert!(
            installed(&directory, "deblur")
                .unwrap_err()
                .to_string()
                .starts_with("ENHANCEMENT_MODELS_BUSY:")
        );
        assert_eq!(digest(&verified_path).unwrap(), verified_hash);
        assert_eq!(
            installed_unlocked(&directory, "deblur").unwrap(),
            (verified_path, first_hash)
        );

        let request = serde_json::from_value(json!({"operation":"deblur"})).unwrap();
        let error = run(
            &directory,
            &DynamicImage::new_rgb8(2, 2),
            None,
            &request,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .err()
        .unwrap();
        assert!(error.to_string().starts_with("ENHANCEMENT_MODELS_BUSY:"));

        drop(guard);
        install(&directory, "deblur", Some(&second), Some(&second_hash))
            .await
            .unwrap();
        assert_eq!(installed(&directory, "deblur").unwrap().1, second_hash);
    }
}
