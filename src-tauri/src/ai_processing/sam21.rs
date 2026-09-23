//! Experimental SAM 2.1 image selection. Its preprocessing and logits are separate from SAM ViT-B.
use std::io::Cursor;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{
    DynamicImage, GenericImageView, GrayImage, ImageFormat, Luma,
    imageops::{self, FilterType},
};
use ndarray::Array;
use ort::{session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{fast_guided_filter, get_models_dir, verify_sha256};

const ENCODER_FILE: &str = "sam2.1_hiera_tiny.encoder.onnx";
const DECODER_FILE: &str = "sam2.1_hiera_tiny.decoder.onnx";
const ENCODER_HASH: &str = "3d5ae796097a6afb1198ceea4187ecaa82736242d07f5658541829d6dfc3f871";
const DECODER_HASH: &str = "197f1c7c8fd070aaf6f15ffc635f4c384422ba5eaa0f8c9e543e3d4b8e0e8e87";
const LOGIT_COUNT: usize = 256 * 256;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f32,
    pub y: f32,
    pub include: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: usize,
    pub score: f32,
    pub mask_data_base64: String,
    pub logits_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub model: &'static str,
    pub image_hash: String,
    pub width: u32,
    pub height: u32,
    pub proposals: Vec<Proposal>,
}

struct EmbeddingCache {
    image_hash: String,
    features: [Array<f32, ndarray::IxDyn>; 3],
}

struct Runtime {
    encoder: Session,
    decoder: Session,
    last: Option<EmbeddingCache>,
}

static RUNTIME: OnceLock<Mutex<Option<Runtime>>> = OnceLock::new();

fn init_runtime(app: &AppHandle) -> Result<Runtime> {
    let dir = get_models_dir(app)?;
    load_runtime(&dir)
}

fn load_runtime(dir: &Path) -> Result<Runtime> {
    let encoder = dir.join(ENCODER_FILE);
    let decoder = dir.join(DECODER_FILE);
    ensure!(
        verify_sha256(&encoder, ENCODER_HASH)?,
        "SAM 2.1 encoder is not installed or failed verification"
    );
    ensure!(
        verify_sha256(&decoder, DECODER_HASH)?,
        "SAM 2.1 decoder is not installed or failed verification"
    );
    let _ = ort::init().with_name("SAM 2.1").commit();
    Ok(Runtime {
        encoder: crate::ai_runtime::load_session(encoder)?,
        decoder: crate::ai_runtime::load_session(decoder)?,
        last: None,
    })
}

fn encode(runtime: &mut Runtime, image: &DynamicImage, image_hash: &str) -> Result<()> {
    if runtime
        .last
        .as_ref()
        .is_some_and(|last| last.image_hash == image_hash)
    {
        return Ok(());
    }
    let rgb = image
        .resize_exact(1024, 1024, FilterType::Triangle)
        .to_rgb8();
    let mut input = Array::<f32, _>::zeros((1, 3, 1024, 1024));
    for (x, y, pixel) in rgb.enumerate_pixels() {
        for channel in 0..3 {
            input[[0, channel, y as usize, x as usize]] = (pixel[channel] as f32 / 255.0
                - [0.485, 0.456, 0.406][channel])
                / [0.229, 0.224, 0.225][channel];
        }
    }
    let outputs = runtime
        .encoder
        .run(ort::inputs![Tensor::from_array(input.into_dyn())?])?;
    ensure!(outputs.len() == 3, "Unexpected SAM 2.1 encoder outputs");
    let features = [
        outputs[2].try_extract_array::<f32>()?.to_owned().into_dyn(),
        outputs[0].try_extract_array::<f32>()?.to_owned().into_dyn(),
        outputs[1].try_extract_array::<f32>()?.to_owned().into_dyn(),
    ];
    ensure!(
        features[0].shape() == [1, 256, 64, 64],
        "Invalid SAM 2.1 embedding"
    );
    ensure!(
        features[1].shape() == [1, 32, 256, 256],
        "Invalid SAM 2.1 high-resolution features"
    );
    ensure!(
        features[2].shape() == [1, 64, 128, 128],
        "Invalid SAM 2.1 high-resolution features"
    );
    runtime.last = Some(EmbeddingCache {
        image_hash: image_hash.to_owned(),
        features,
    });
    Ok(())
}

fn decode_logits(encoded: Option<&str>) -> Result<Vec<f32>> {
    let Some(encoded) = encoded else {
        return Ok(vec![0.0; LOGIT_COUNT]);
    };
    let bytes = STANDARD.decode(encoded)?;
    ensure!(
        bytes.len() == LOGIT_COUNT * 4,
        "Invalid SAM 2.1 prior logits"
    );
    let logits: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect();
    ensure!(
        logits.iter().all(|v| v.is_finite()),
        "Non-finite SAM 2.1 prior logits"
    );
    Ok(logits)
}

fn encode_logits(logits: &[f32]) -> String {
    STANDARD.encode(
        logits
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>(),
    )
}

fn binary_mask(logits: &[f32], width: u32, height: u32) -> GrayImage {
    let mut mask = GrayImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let sx = ((x as f32 + 0.5) * 256.0 / width as f32 - 0.5).clamp(0.0, 255.0);
            let sy = ((y as f32 + 0.5) * 256.0 / height as f32 - 0.5).clamp(0.0, 255.0);
            let x0 = sx.floor() as usize;
            let y0 = sy.floor() as usize;
            let x1 = (x0 + 1).min(255);
            let y1 = (y0 + 1).min(255);
            let fx = sx - x0 as f32;
            let fy = sy - y0 as f32;
            let value = (1.0 - fy)
                * ((1.0 - fx) * logits[y0 * 256 + x0] + fx * logits[y0 * 256 + x1])
                + fy * ((1.0 - fx) * logits[y1 * 256 + x0] + fx * logits[y1 * 256 + x1]);
            mask.put_pixel(x, y, Luma([if value > 0.0 { 255 } else { 0 }]));
        }
    }
    mask
}

fn encode_mask(mask: GrayImage) -> Result<String> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageLuma8(mask).write_to(&mut bytes, ImageFormat::Png)?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes.into_inner())
    ))
}

pub fn finish(
    image: &DynamicImage,
    expected_image_hash: &str,
    encoded_logits: &str,
) -> Result<String> {
    let rgb = image.to_rgb8();
    ensure!(
        blake3::hash(rgb.as_raw()).to_hex().as_str() == expected_image_hash,
        "SAM 2.1 image changed during refinement"
    );
    let (width, height) = image.dimensions();
    let logits = decode_logits(Some(encoded_logits))?;
    let coarse = binary_mask(&logits, width, height);
    let radius = (width.max(height) as f32 * 0.0075).clamp(8.0, 24.0);
    let soft = imageops::blur(&coarse, radius / 3.0);
    let mut refined = fast_guided_filter(&image.to_luma8(), &soft, radius as usize, 0.01);
    for pixel in refined.pixels_mut() {
        pixel[0] =
            (((pixel[0] as f32 / 255.0 - 0.03) / 0.94).clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    encode_mask(refined)
}

pub fn propose(
    app: &AppHandle,
    image: &DynamicImage,
    bbox: Option<[f32; 4]>,
    points: &[Point],
    prior: Option<&str>,
    expected_image_hash: Option<&str>,
) -> Result<ResultSet> {
    let lock = RUNTIME.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if guard.is_none() {
        *guard = Some(init_runtime(app)?);
    }
    propose_with_runtime(
        guard.as_mut().unwrap(),
        image,
        bbox,
        points,
        prior,
        expected_image_hash,
    )
}

fn propose_with_runtime(
    runtime: &mut Runtime,
    image: &DynamicImage,
    bbox: Option<[f32; 4]>,
    points: &[Point],
    prior: Option<&str>,
    expected_image_hash: Option<&str>,
) -> Result<ResultSet> {
    let (width, height) = image.dimensions();
    ensure!(
        width > 0 && height > 0 && width as u64 * height as u64 <= 100_000_000,
        "Unsupported SAM 2.1 image dimensions"
    );
    ensure!(
        points.len() <= 64 && (bbox.is_some() || points.iter().any(|p| p.include)),
        "A box or positive point is required"
    );
    for p in points {
        ensure!(
            p.x.is_finite()
                && p.y.is_finite()
                && p.x >= 0.0
                && p.y >= 0.0
                && p.x < width as f32
                && p.y < height as f32,
            "SAM 2.1 point is outside image"
        );
    }
    if let Some([x1, y1, x2, y2]) = bbox {
        ensure!(
            [x1, y1, x2, y2].iter().all(|n| n.is_finite())
                && x1 >= 0.0
                && y1 >= 0.0
                && x1 < x2
                && y1 < y2
                && x2 <= width as f32
                && y2 <= height as f32,
            "Invalid SAM 2.1 box"
        );
    }
    let rgb = image.to_rgb8();
    let image_hash = blake3::hash(rgb.as_raw()).to_hex().to_string();
    if let Some(expected) = expected_image_hash {
        ensure!(
            expected == image_hash,
            "SAM 2.1 image changed during correction"
        );
    }
    encode(runtime, image, &image_hash)?;
    let features = &runtime.last.as_ref().unwrap().features;
    let mut coords = Vec::with_capacity((points.len() + 3) * 2);
    let mut labels = Vec::with_capacity(points.len() + 3);
    for point in points {
        coords.extend([
            point.x * 1024.0 / width as f32,
            point.y * 1024.0 / height as f32,
        ]);
        labels.push(if point.include { 1.0f32 } else { 0.0f32 });
    }
    if let Some([x1, y1, x2, y2]) = bbox {
        coords.extend([x1 * 1024.0 / width as f32, y1 * 1024.0 / height as f32]);
        coords.extend([x2 * 1024.0 / width as f32, y2 * 1024.0 / height as f32]);
        labels.extend([2.0f32, 3.0f32]);
    }
    if bbox.is_none() {
        coords.extend([0.0, 0.0]);
        labels.push(-1.0f32);
    }
    let count = labels.len();
    let outputs = runtime.decoder.run(ort::inputs![
        Tensor::from_array(features[0].clone())?,
        Tensor::from_array(features[1].clone())?,
        Tensor::from_array(features[2].clone())?,
        Tensor::from_array(Array::from_shape_vec((1, count, 2), coords)?.into_dyn())?,
        Tensor::from_array(Array::from_shape_vec((1, count), labels)?.into_dyn())?,
        Tensor::from_array(
            Array::from_shape_vec((1, 1, 256, 256), decode_logits(prior)?)?.into_dyn()
        )?,
        Tensor::from_array(
            Array::from_elem((1,), if prior.is_some() { 1.0f32 } else { 0.0 }).into_dyn()
        )?,
    ])?;
    ensure!(outputs.len() == 2, "Unexpected SAM 2.1 decoder outputs");
    let masks = outputs[0].try_extract_array::<f32>()?;
    let scores = outputs[1].try_extract_array::<f32>()?;
    ensure!(
        masks.shape() == [1, 3, 256, 256] && scores.shape() == [1, 3],
        "Unexpected SAM 2.1 proposal shapes"
    );
    let mask_values = masks
        .as_slice()
        .ok_or_else(|| anyhow::anyhow!("Non-contiguous SAM 2.1 masks"))?;
    let score_values = scores
        .as_slice()
        .ok_or_else(|| anyhow::anyhow!("Non-contiguous SAM 2.1 scores"))?;
    ensure!(
        mask_values.iter().all(|v| v.is_finite()) && score_values.iter().all(|v| v.is_finite()),
        "Non-finite SAM 2.1 result"
    );
    let proposals = (0..3)
        .map(|id| {
            let logits = &mask_values[id * LOGIT_COUNT..(id + 1) * LOGIT_COUNT];
            Ok(Proposal {
                id,
                score: score_values[id],
                mask_data_base64: encode_mask(binary_mask(logits, width, height))?,
                logits_base64: encode_logits(logits),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ResultSet {
        model: "sam2.1-hiera-tiny",
        image_hash,
        width,
        height,
        proposals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires SAM21_MODEL_DIR and SAM21_TEST_IMAGE"]
    fn local_model_returns_three_reusable_proposals() {
        let models = std::env::var("SAM21_MODEL_DIR").unwrap();
        let image = image::open(std::env::var("SAM21_TEST_IMAGE").unwrap()).unwrap();
        let mut runtime = load_runtime(Path::new(&models)).unwrap();
        let first = propose_with_runtime(
            &mut runtime,
            &image,
            Some([286.72, 61.44, 1003.52, 1336.32]),
            &[],
            None,
            None,
        )
        .unwrap();
        assert_eq!(first.proposals.len(), 3);
        assert_eq!((first.width, first.height), image.dimensions());
        assert!(
            first
                .proposals
                .iter()
                .all(|p| p.mask_data_base64.starts_with("data:image/png;base64,"))
        );
        let selected = first
            .proposals
            .iter()
            .max_by(|a, b| a.score.total_cmp(&b.score))
            .unwrap();
        let second = propose_with_runtime(
            &mut runtime,
            &image,
            Some([286.72, 61.44, 1003.52, 1336.32]),
            &[Point {
                x: 790.0,
                y: 690.0,
                include: false,
            }],
            Some(&selected.logits_base64),
            Some(&first.image_hash),
        )
        .unwrap();
        assert_eq!(second.image_hash, first.image_hash);
        assert_eq!(second.proposals.len(), 3);
        let final_mask = finish(
            &image,
            &second.image_hash,
            &second.proposals[2].logits_base64,
        )
        .unwrap();
        assert!(final_mask.starts_with("data:image/png;base64,"));
    }
}
