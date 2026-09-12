//! MCP subject prompts retain caller constraints and native SAM mask-input logits.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};

pub(crate) const LOGIT_COUNT: usize = 256 * 256;
pub(crate) const LOGIT_BASE64_LENGTH: usize = 349_528;
pub(crate) type SubjectBox = ((f64, f64), (f64, f64));

#[derive(Clone, Debug)]
pub(crate) struct SubjectPoint {
    pub x: f64,
    pub y: f64,
    pub include: bool,
}

pub(crate) fn decode_logits(encoded: &str) -> Result<Vec<f32>> {
    anyhow::ensure!(
        encoded.len() == LOGIT_BASE64_LENGTH,
        "Invalid SAM logit byte length"
    );
    let bytes = STANDARD.decode(encoded)?;
    anyhow::ensure!(
        bytes.len() == LOGIT_COUNT * 4,
        "Invalid SAM logit dimensions"
    );
    let values: Vec<_> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    anyhow::ensure!(
        values.iter().all(|v| v.is_finite()),
        "SAM logits must be finite"
    );
    Ok(values)
}

pub(crate) fn encode_logits(values: &[f32]) -> Result<String> {
    anyhow::ensure!(
        values.len() == LOGIT_COUNT && values.iter().all(|v| v.is_finite()),
        "Invalid native SAM logits"
    );
    Ok(STANDARD.encode(
        values
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    ))
}

/// Legacy selection opacity is an approximate probability seed, never native logits.
/// Match SAM's top-left image placement: resize the image region, pad right/bottom,
/// then sample the padded 1024 canvas to 256. Never stretch a rectangular mask square.
pub(crate) fn coverage_logit_seed(mask: &GrayImage) -> Vec<f32> {
    let (w, h) = mask.dimensions();
    let scale = 1024.0 / w.max(h) as f64;
    let rw = (w as f64 * scale).round().max(1.0) as u32;
    let rh = (h as f64 * scale).round().max(1.0) as u32;
    let resized = imageops::resize(mask, rw, rh, FilterType::Triangle);
    let mut padded = ImageBuffer::<Luma<f32>, Vec<f32>>::from_pixel(1024, 1024, Luma([-6.906755]));
    for (x, y, p) in resized.enumerate_pixels() {
        let probability = (p[0] as f32 / 255.0).clamp(0.001, 0.999);
        padded.put_pixel(x, y, Luma([(probability / (1.0 - probability)).ln()]));
    }
    // image::imageops::resize clamps floating image channels to [0,1].
    // SAM needs signed, unbounded logits. A 4:1 align_corners=false bilinear
    // sample lies halfway between indices 4*x+1 and 4*x+2 in each dimension.
    let mut logits = vec![0.0; LOGIT_COUNT];
    for y in 0..256 {
        for x in 0..256 {
            logits[(y * 256 + x) as usize] = (padded[(x * 4 + 1, y * 4 + 1)][0]
                + padded[(x * 4 + 2, y * 4 + 1)][0]
                + padded[(x * 4 + 1, y * 4 + 2)][0]
                + padded[(x * 4 + 2, y * 4 + 2)][0])
                * 0.25;
        }
    }
    logits
}

pub(crate) fn canvas_embeddings(
    image: &DynamicImage,
    encoder: &Mutex<Session>,
) -> Result<ImageEmbeddings> {
    let (w, h) = image.dimensions();
    let scale = 1024.0 / w.max(h) as f64;
    let rw = (w as f64 * scale).round().max(1.0) as u32;
    let rh = (h as f64 * scale).round().max(1.0) as u32;
    let rgb = image.resize_exact(rw, rh, FilterType::Triangle).to_rgb8();
    let mut tensor = Array::<u8, _>::zeros((1, 3, 1024, 1024));
    for (x, y, p) in rgb.enumerate_pixels() {
        for c in 0..3 {
            tensor[[0, c, y as usize, x as usize]] = p[c];
        }
    }
    let mut session = encoder.lock().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let outputs = session.run(ort::inputs![Tensor::from_array(tensor.into_dyn())?])?;
    Ok(ImageEmbeddings {
        path_hash: String::new(),
        embeddings: outputs[0].try_extract_array::<f32>()?.to_owned().into_dyn(),
        original_size: (w, h),
    })
}

fn prompt_tensors(
    points: &[SubjectPoint],
    bbox: Option<SubjectBox>,
    dimensions: (u32, u32),
) -> Result<(Array<f32, IxDyn>, Array<f32, IxDyn>)> {
    anyhow::ensure!(dimensions.0 > 0 && dimensions.1 > 0, "Empty SAM image");
    anyhow::ensure!(
        points.len() <= 64,
        "At most 64 subject points are supported"
    );
    let scale = 1024.0 / dimensions.0.max(dimensions.1) as f64;
    let sx = (dimensions.0 as f64 * scale).round().max(1.0) / dimensions.0 as f64;
    let sy = (dimensions.1 as f64 * scale).round().max(1.0) / dimensions.1 as f64;
    let mut coords = Vec::new();
    let mut labels = Vec::new();
    for point in points {
        anyhow::ensure!(
            point.x.is_finite()
                && point.y.is_finite()
                && point.x >= 0.0
                && point.y >= 0.0
                && point.x < dimensions.0 as f64
                && point.y < dimensions.1 as f64,
            "Subject point is outside mask canvas"
        );
        coords.extend([(point.x * sx) as f32, (point.y * sy) as f32]);
        labels.push(if point.include { 1.0 } else { 0.0 });
    }
    if let Some((a, b)) = bbox {
        anyhow::ensure!(
            [a.0, a.1, b.0, b.1].iter().all(|v| v.is_finite())
                && a.0 >= 0.0
                && a.1 >= 0.0
                && b.0 <= dimensions.0 as f64
                && b.1 <= dimensions.1 as f64
                && a.0 < b.0
                && a.1 < b.1,
            "Invalid SAM subject box"
        );
        coords.extend([
            (a.0 * sx) as f32,
            (a.1 * sy) as f32,
            (b.0 * sx) as f32,
            (b.1 * sy) as f32,
        ]);
        labels.extend([2.0, 3.0]);
    } else {
        // SAM's no-box point prompt includes the not-a-point padding token.
        coords.extend([0.0, 0.0]);
        labels.push(-1.0);
    }
    Ok((
        Array::from_shape_vec((1, labels.len(), 2), coords)?.into_dyn(),
        Array::from_shape_vec((1, labels.len()), labels)?.into_dyn(),
    ))
}

pub(crate) fn run_prompted_decoder(
    decoder: &Mutex<Session>,
    embeddings: &ImageEmbeddings,
    points: &[SubjectPoint],
    bbox: Option<SubjectBox>,
    prior: Option<&[f32]>,
    image: &DynamicImage,
) -> Result<(GrayImage, Vec<f32>)> {
    let dimensions = embeddings.original_size;
    anyhow::ensure!(
        image.dimensions() == dimensions,
        "SAM guide dimensions differ from embeddings"
    );
    let (coords, labels) = prompt_tensors(points, bbox, dimensions)?;
    let mut logits = prior.map_or_else(|| vec![0.0; LOGIT_COUNT], <[f32]>::to_vec);
    anyhow::ensure!(
        logits.len() == LOGIT_COUNT && logits.iter().all(|v| v.is_finite()),
        "Invalid prior SAM logits"
    );
    let mut final_mask = None;
    for iteration in 0..2 {
        // Both decoder passes receive identical caller points and box. No synthetic
        // negative point or inferred smaller box is allowed to overwrite them.
        let mut session = decoder.lock().map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let outputs = session.run(ort::inputs![
            Tensor::from_array(embeddings.embeddings.clone())?,
            Tensor::from_array(coords.clone())?,
            Tensor::from_array(labels.clone())?,
            Tensor::from_array(Array::from_shape_vec((1, 1, 256, 256), logits)?.into_dyn())?,
            Tensor::from_array(
                Array::from_elem(
                    (1,),
                    if prior.is_some() || iteration > 0 {
                        1.0f32
                    } else {
                        0.0
                    }
                )
                .into_dyn()
            )?,
            Tensor::from_array(
                Array::from_shape_vec((2,), vec![dimensions.1 as f32, dimensions.0 as f32])?
                    .into_dyn()
            )?
        ])?;
        anyhow::ensure!(
            outputs.len() == 3,
            "Verified SAM decoder must return masks, scores and low-resolution logits"
        );
        let masks = outputs[0].try_extract_array::<f32>()?;
        let scores = outputs[1].try_extract_array::<f32>()?;
        let low = outputs[2].try_extract_array::<f32>()?;
        let shape = masks.shape();
        anyhow::ensure!(
            shape.len() == 4
                && shape[0] == 1
                && shape[1] > 0
                && shape[2] == dimensions.1 as usize
                && shape[3] == dimensions.0 as usize,
            "Unexpected SAM output mask shape"
        );
        let count = shape[1];
        anyhow::ensure!(
            low.shape() == [1, count, 256, 256] && scores.len() == count,
            "Unexpected SAM score/logit shape"
        );
        let scores = scores
            .as_slice()
            .ok_or_else(|| anyhow::anyhow!("Non-contiguous SAM scores"))?;
        anyhow::ensure!(scores.iter().all(|v| v.is_finite()), "Non-finite SAM score");
        let selected = (0..count)
            .max_by(|a, b| scores[*a].total_cmp(&scores[*b]))
            .unwrap();
        logits = low
            .as_slice()
            .ok_or_else(|| anyhow::anyhow!("Non-contiguous SAM logits"))?
            [selected * LOGIT_COUNT..(selected + 1) * LOGIT_COUNT]
            .to_vec();
        anyhow::ensure!(
            logits.iter().all(|v| v.is_finite()),
            "Non-finite SAM logits"
        );
        let area = dimensions.0 as usize * dimensions.1 as usize;
        let pixels = &masks
            .as_slice()
            .ok_or_else(|| anyhow::anyhow!("Non-contiguous SAM masks"))?
            [selected * area..(selected + 1) * area];
        anyhow::ensure!(pixels.iter().all(|v| v.is_finite()), "Non-finite SAM mask");
        final_mask = GrayImage::from_raw(
            dimensions.0,
            dimensions.1,
            pixels
                .iter()
                .map(|v| if *v > 0.0 { 255 } else { 0 })
                .collect(),
        );
    }
    let coarse = final_mask.ok_or_else(|| anyhow::anyhow!("SAM returned no mask"))?;
    let radius = (dimensions.0.max(dimensions.1) as f32 * 0.0075).clamp(8.0, 24.0);
    let soft = imageops::blur(&coarse, radius / 3.0);
    let mut refined = fast_guided_filter(&image.to_luma8(), &soft, radius as usize, 0.01);
    for p in refined.pixels_mut() {
        p[0] = (((p[0] as f32 / 255.0 - 0.03) / 0.94).clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    Ok((refined, logits))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coverage_seed_preserves_rectangular_padding_and_logit_sign() {
        let mask = GrayImage::from_pixel(800, 400, Luma([255]));
        let seed = coverage_logit_seed(&mask);
        assert!(seed[64 * 256 + 64] > 6.0);
        assert!(seed[192 * 256 + 64] < -6.0);
        let soft = coverage_logit_seed(&GrayImage::from_pixel(256, 256, Luma([128])));
        assert!((soft[100] - (128.0f32 / 127.0).ln()).abs() < 0.00001);
    }
    #[test]
    fn native_logits_roundtrip_exactly_and_reject_corruption() {
        let data: Vec<f32> = (0..LOGIT_COUNT).map(|i| i as f32 / 17.0 - 128.0).collect();
        let encoded = encode_logits(&data).unwrap();
        assert_eq!(encoded.len(), LOGIT_BASE64_LENGTH);
        assert_eq!(decode_logits(&encoded).unwrap(), data);
        assert!(decode_logits(&encoded[..encoded.len() - 1]).is_err());
        let mut invalid = data;
        invalid[0] = f32::NAN;
        assert!(encode_logits(&invalid).is_err());
    }
    #[test]
    fn caller_positive_negative_and_box_prompts_have_exact_labels() {
        let points = [
            SubjectPoint {
                x: 250.0,
                y: 125.0,
                include: true,
            },
            SubjectPoint {
                x: 750.0,
                y: 300.0,
                include: false,
            },
        ];
        let (coords, labels) =
            prompt_tensors(&points, Some(((20.0, 10.0), (990.0, 480.0))), (1000, 500)).unwrap();
        assert_eq!(labels.as_slice().unwrap(), &[1.0, 0.0, 2.0, 3.0]);
        assert_eq!(
            &coords.as_slice().unwrap()[..4],
            &[256.0, 128.0, 768.0, 307.2]
        );
        let (_, labels) = prompt_tensors(&points, None, (1000, 500)).unwrap();
        assert_eq!(labels.as_slice().unwrap(), &[1.0, 0.0, -1.0]);
        assert!(
            prompt_tensors(
                &[SubjectPoint {
                    x: 1000.0,
                    y: 2.0,
                    include: true
                }],
                None,
                (1000, 500)
            )
            .is_err()
        );
    }
}
