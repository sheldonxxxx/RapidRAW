//! Optional saved surface maps; pixels always pass through the native renderer.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, GrayImage, ImageFormat, imageops::FilterType};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Cursor, time::Duration};

use crate::mask_generation::MaskDefinition;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceArtifact {
    pub version: u8,
    pub kind: String,
    pub source_width: u32,
    pub source_height: u32,
    pub source_hash: String,
    pub geometry_hash: String,
    pub workflow_hash: String,
    pub map_hash: String,
    pub profile: String,
}

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn geometry_hash(a: &Value) -> String {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Number(n) => n
                .as_f64()
                .filter(|v| v.fract() == 0.0 && v.abs() < 9e15)
                .map_or_else(|| value.clone(), |v| json!(v as i64)),
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            Value::Object(items) => Value::Object(
                items
                    .iter()
                    .map(|(k, v)| (k.clone(), canonical(v)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    let mut geometry = serde_json::Map::new();
    for key in crate::cache_utils::GEOMETRY_KEYS
        .iter()
        .copied()
        .chain(["aiPatches"])
    {
        geometry.insert(key.into(), canonical(&a[key]));
    }
    sha256(&serde_json::to_vec(&geometry).unwrap())
}

pub fn is_surface(kind: &str) -> bool {
    matches!(kind, "ai-normals" | "ai-albedo")
}

#[tauri::command]
pub async fn test_marigold_surface_connection(address: String) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let result = crate::marigold_depth::response_json(
        client
            .get(format!(
                "{}/materials/capabilities",
                crate::marigold_depth::endpoint(&address)?
            ))
            .send()
            .await
            .map_err(crate::marigold_depth::connection_error)?,
    )
    .await?;
    if result["protocol_version"] != 1 {
        return Err("Incompatible surface connector".into());
    }
    Ok(result)
}

#[tauri::command]
pub async fn generate_marigold_surface_mask(
    kind: String,
    js_adjustments: Value,
    path: String,
    state: tauri::State<'_, crate::app_state::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Value, String> {
    if !matches!(kind.as_str(), "normals" | "albedo") {
        return Err("Choose normals or albedo".into());
    }
    let settings = crate::app_settings::load_settings(app_handle)?;
    if !settings.marigold_surface_enabled {
        return Err("Enable optional Marigold normals and albedo first".into());
    }
    let address = settings
        .ai_connector_address
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or("Configure the AI connector address")?;
    let original = state
        .original_image
        .lock()
        .map_err(|_| "Image state unavailable")?
        .as_ref()
        .cloned()
        .ok_or("Open a photo first")?;
    if original.path != path {
        return Err("Photo changed before surface analysis started".into());
    }
    let mut patched =
        crate::image_loader::composite_patches_on_image(&original.image, &js_adjustments)
            .map_err(|e| format!("Could not prepare surface analysis: {e}"))?;
    if original.is_raw {
        crate::apply_cpu_default_raw_processing(&mut patched);
    }
    let warped = crate::apply_geometry_warp(std::borrow::Cow::Owned(patched), &js_adjustments);
    let (width, height) = (warped.width(), warped.height());
    let analysis = warped.resize(1024, 1024, FilterType::Lanczos3).to_rgb8();
    if analysis.width().min(analysis.height()) < 64 {
        return Err("Surface analysis needs at least 64 pixels on each edge".into());
    }
    let mut png = Cursor::new(Vec::new());
    analysis
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let source_hash = sha256(png.get_ref());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(480))
        .build()
        .map_err(|e| e.to_string())?;
    let part = reqwest::multipart::Part::bytes(png.into_inner())
        .file_name("analysis.png")
        .mime_str("image/png")
        .map_err(|e| e.to_string())?;
    let response = crate::marigold_depth::response_json(
        client
            .post(format!(
                "{}/materials/{kind}",
                crate::marigold_depth::endpoint(address)?
            ))
            .multipart(reqwest::multipart::Form::new().part("file", part))
            .send()
            .await
            .map_err(crate::marigold_depth::connection_error)?,
    )
    .await?;
    let encoded = response["map_png_base64"]
        .as_str()
        .ok_or("Missing surface map")?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid surface map encoding")?;
    let map = decode_map(&bytes)?;
    let meta = &response["metadata"];
    let profile = format!("marigold-v2-{kind}-q4-v1");
    let space = if kind == "normals" {
        "camera-unit-normal-xyz-encoded-0-1"
    } else {
        "srgb-albedo"
    };
    if meta["kind"] != kind
        || meta["profile"] != profile
        || meta["space"] != space
        || meta["encoding"] != "rgb16-png"
        || meta["width"] != map.width()
        || meta["height"] != map.height()
        || meta["source_sha256"] != source_hash
        || meta["map_sha256"] != sha256(&bytes)
    {
        return Err("Surface map provenance, profile or dimensions do not match".into());
    }
    let artifact = SurfaceArtifact {
        version: 1,
        kind,
        source_width: width,
        source_height: height,
        source_hash,
        geometry_hash: geometry_hash(&js_adjustments),
        workflow_hash: meta["workflow_sha256"].as_str().unwrap_or("").into(),
        map_hash: sha256(&bytes),
        profile,
    };
    let data = format!("data:image/png;base64,{encoded}");
    validate_artifact(&data, &artifact)?;
    // Even native callers must not accept a result from a replaced image object.
    if state
        .original_image
        .lock()
        .map_err(|_| "Image state unavailable")?
        .as_ref()
        .is_none_or(|now| now.path != path || !std::sync::Arc::ptr_eq(&now.image, &original.image))
    {
        return Err("Photo changed while surface analysis was running".into());
    }
    Ok(
        json!({"surfaceArtifact":artifact,"maskDataBase64":data,"rotation":js_adjustments["rotation"].as_f64().unwrap_or(0.0),"orientationSteps":js_adjustments["orientationSteps"].as_u64().unwrap_or(0),"flipHorizontal":js_adjustments["flipHorizontal"].as_bool().unwrap_or(false),"flipVertical":js_adjustments["flipVertical"].as_bool().unwrap_or(false)}),
    )
}

fn decode_map(bytes: &[u8]) -> Result<image::ImageBuffer<image::Rgb<u16>, Vec<u16>>, String> {
    if bytes.len() < 33 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || bytes[24] != 16 || bytes[25] != 2
    {
        return Err("Expected an RGB16 surface PNG".into());
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if w == 0 || h == 0 || w as u64 * h as u64 > 1_048_576 {
        return Err("Surface map exceeds one megapixel".into());
    }
    let image =
        image::load_from_memory_with_format(bytes, ImageFormat::Png).map_err(|e| e.to_string())?;
    match image {
        DynamicImage::ImageRgb16(rgb) => Ok(rgb),
        _ => Err("Expected RGB16 pixels".into()),
    }
}

pub fn validate_artifact(data: &str, a: &SurfaceArtifact) -> Result<(), String> {
    if a.version != 1
        || !matches!(a.kind.as_str(), "normals" | "albedo")
        || a.profile != format!("marigold-v2-{}-q4-v1", a.kind)
        || a.source_width == 0
        || a.source_height == 0
        || a.source_width as u64 * a.source_height as u64 > 100_000_000
    {
        return Err("Invalid surface artifact".into());
    }
    for hash in [
        &a.source_hash,
        &a.geometry_hash,
        &a.workflow_hash,
        &a.map_hash,
    ] {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("Invalid surface provenance hash".into());
        }
    }
    let bytes = STANDARD
        .decode(data.split_once(',').map_or(data, |(_, v)| v))
        .map_err(|_| "Invalid surface PNG encoding")?;
    decode_map(&bytes)?;
    if sha256(&bytes) != a.map_hash {
        return Err("Surface map checksum mismatch".into());
    }
    Ok(())
}

fn linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Build a positive or opposing normal lobe, or an albedo colour range.
/// The stored map stays RGB16; only the final native mask is quantized to u8.
pub fn selection(params: &Value) -> Option<GrayImage> {
    let a: SurfaceArtifact = serde_json::from_value(params["surfaceArtifact"].clone()).ok()?;
    let data = params["maskDataBase64"].as_str()?;
    validate_artifact(data, &a).ok()?;
    let bytes = STANDARD
        .decode(data.split_once(',').map_or(data, |(_, v)| v))
        .ok()?;
    let rgb = decode_map(&bytes).ok()?;
    let mut values = Vec::with_capacity((rgb.width() * rgb.height()) as usize);
    let (w, h) = rgb.dimensions();
    let mut target = [0.0; 3];
    if a.kind == "albedo" {
        let x = (params["surfacePointX"]
            .as_f64()
            .unwrap_or(0.5)
            .clamp(0.0, 1.0)
            * (w - 1) as f64)
            .round() as u32;
        let y = (params["surfacePointY"]
            .as_f64()
            .unwrap_or(0.5)
            .clamp(0.0, 1.0)
            * (h - 1) as f64)
            .round() as u32;
        let mut samples = [Vec::new(), Vec::new(), Vec::new()];
        for py in y.saturating_sub(2)..=(y + 2).min(h - 1) {
            for px in x.saturating_sub(2)..=(x + 2).min(w - 1) {
                let p = rgb.get_pixel(px, py).0.map(|v| linear(v as f32 / 65535.0));
                let sum = p.iter().sum::<f32>().max(1e-6);
                for c in 0..3 {
                    samples[c].push(p[c] / sum);
                }
            }
        }
        for c in 0..3 {
            samples[c].sort_by(f32::total_cmp);
            target[c] = samples[c][samples[c].len() / 2];
        }
    }
    // Direction is relative to the displayed image: undo fine rotation, flips,
    // then coarse rotation before dotting against camera-space normals.
    let angle = (params["normalAngle"].as_f64().unwrap_or(0.0)
        + params["rotation"].as_f64().unwrap_or(0.0))
    .to_radians();
    let mut light = [angle.cos() as f32, angle.sin() as f32];
    if params["flipHorizontal"] == true {
        light[0] = -light[0];
    }
    if params["flipVertical"] == true {
        light[1] = -light[1];
    }
    for _ in 0..params["orientationSteps"].as_u64().unwrap_or(0) % 4 {
        light = [-light[1], light[0]];
    }
    let opposite = if params["normalOpposing"] == true {
        -1.0
    } else {
        1.0
    };
    let tolerance = params["surfaceTolerance"]
        .as_f64()
        .unwrap_or(0.13)
        .clamp(0.005, 1.0) as f32;
    for p in rgb.pixels() {
        let weight = if a.kind == "normals" {
            let n = p.0.map(|v| v as f32 / 32767.5 - 1.0);
            let len = n.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-6);
            ((n[0] * light[0] + n[1] * light[1]) * opposite / len).clamp(0.0, 1.0)
        } else {
            let p = p.0.map(|v| linear(v as f32 / 65535.0));
            let sum = p.iter().sum::<f32>();
            let distance = (0..3)
                .map(|c| (p[c] / sum.max(1e-6) - target[c]).powi(2))
                .sum::<f32>()
                .sqrt();
            let t = ((tolerance * 1.5 - distance) / tolerance).clamp(0.0, 1.0);
            t * t * (3.0 - 2.0 * t) * (sum / 0.015).clamp(0.0, 1.0)
        };
        values.push((weight * 255.0).round() as u8);
    }
    let small = GrayImage::from_raw(w, h, values)?;
    Some(image::imageops::resize(
        &small,
        a.source_width,
        a.source_height,
        FilterType::Triangle,
    ))
}

/// Expand signed lighting into two native exposure masks. Saved state retains
/// one editable component; both lobes share its regional masks and opacity.
pub fn render_masks(a: &Value) -> Vec<MaskDefinition> {
    let masks: Vec<MaskDefinition> = a
        .get("masks")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    if !masks
        .iter()
        .any(|m| m.sub_masks.iter().any(|s| is_surface(&s.mask_type)))
    {
        return masks;
    }
    let current_geometry = geometry_hash(a);
    let mut out = Vec::new();
    for mut mask in masks {
        let surface_indices: Vec<_> = mask
            .sub_masks
            .iter()
            .enumerate()
            .filter(|(_, s)| s.visible && is_surface(&s.mask_type))
            .map(|(i, _)| i)
            .collect();
        if surface_indices.len() > 1
            || surface_indices.iter().any(|i| {
                mask.sub_masks[*i].parameters["surfaceArtifact"]["geometryHash"].as_str()
                    != Some(&current_geometry)
            })
        {
            // Keep a zero bitmap entry so every render path retains the same order.
            for part in &mut mask.sub_masks {
                part.visible = false;
            }
            mask.invert = false;
            out.push(mask);
            continue;
        }
        let mut shadow = None;
        for index in surface_indices {
            let part = &mask.sub_masks[index];
            if part.mask_type == "ai-normals" {
                let amount = part.parameters["normalAmount"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .clamp(-1.5, 1.5);
                if amount != 0.0 {
                    let mut other = mask.clone();
                    other.id.push_str("-surface-opposing");
                    other.sub_masks[index].parameters["normalOpposing"] = json!(true);
                    other.adjustments = json!({"exposure":-amount*0.8, "sectionVisibility":mask.adjustments["sectionVisibility"].clone()});
                    shadow = Some(other);
                    let exposure = mask.adjustments["exposure"].as_f64().unwrap_or(0.0);
                    mask.adjustments["exposure"] = json!(exposure + amount * 0.8);
                }
            } else {
                mask.adjustments["surfaceRecolorAmount"] = part.parameters["surfaceAmount"].clone();
                mask.adjustments["surfaceRecolor"] = part.parameters["surfaceColor"].clone();
            }
        }
        out.push(mask);
        if let Some(shadow) = shadow {
            out.push(shadow);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn parameters(
        kind: &str,
        pixels: Vec<u16>,
        width: u32,
        height: u32,
        geometry: &Value,
    ) -> Value {
        let rgb: ImageBuffer<Rgb<u16>, Vec<u16>> =
            ImageBuffer::from_raw(width, height, pixels).unwrap();
        let mut png = Cursor::new(Vec::new());
        rgb.write_to(&mut png, ImageFormat::Png).unwrap();
        let artifact = SurfaceArtifact {
            version: 1,
            kind: kind.into(),
            source_width: width,
            source_height: height,
            source_hash: "a".repeat(64),
            geometry_hash: geometry_hash(geometry),
            workflow_hash: "b".repeat(64),
            map_hash: sha256(png.get_ref()),
            profile: format!("marigold-v2-{kind}-q4-v1"),
        };
        json!({"maskDataBase64":format!("data:image/png;base64,{}", STANDARD.encode(png.get_ref())),
            "surfaceArtifact":artifact, "normalAngle":0, "normalAmount":0.5,
            "rotation":0,"orientationSteps":0,"flipHorizontal":false,"flipVertical":false})
    }

    fn mask(p: Value, kind: &str) -> Value {
        json!({"id":"m","name":"Surface","visible":true,"invert":false,"opacity":100,"adjustments":{},
            "subMasks":[{"id":"s","type":format!("ai-{kind}"),"visible":true,"invert":false,"opacity":100,"mode":"additive","parameters":p}]})
    }

    #[test]
    fn cached_surface_components_preserve_subtract_brush_and_opposing_lobes() {
        for kind in ["normals", "albedo"] {
            let p = parameters(
                kind,
                vec![
                    65535,
                    32768,
                    32768,
                    if kind == "albedo" { 65535 } else { 0 },
                    32768,
                    32768,
                ],
                2,
                1,
                &json!({}),
            );
            let mut def: MaskDefinition = serde_json::from_value(mask(p, kind)).unwrap();
            let base =
                crate::mask_generation::generate_mask_bitmap(&def, 2, 1, 1.0, (0.0, 0.0), None)
                    .unwrap();
            assert!(base.as_raw().iter().any(|v| *v > 0), "{kind}");
            // Warm the component cache before adding a subtract stroke.
            assert_eq!(
                crate::mask_generation::generate_mask_bitmap(&def, 2, 1, 1.0, (0.0, 0.0), None),
                Some(base.clone())
            );
            def.sub_masks.push(serde_json::from_value(json!({"id":"b","type":"brush","visible":true,"mode":"subtractive","parameters":{"lines":[{"tool":"brush","brushSize":8,"feather":0,"points":[{"x":0,"y":0}]}]}})).unwrap());
            let subtracted =
                crate::mask_generation::generate_mask_bitmap(&def, 2, 1, 1.0, (0.0, 0.0), None)
                    .unwrap();
            assert!(
                subtracted
                    .as_raw()
                    .iter()
                    .zip(base.as_raw())
                    .any(|(a, b)| a < b)
            );
            def.sub_masks.pop();
            if kind == "normals" {
                def.sub_masks[0].parameters["normalOpposing"] = json!(true);
                let opposing =
                    crate::mask_generation::generate_mask_bitmap(&def, 2, 1, 1.0, (0.0, 0.0), None)
                        .unwrap();
                assert_ne!(base, opposing);
            }
            def.sub_masks[0].parameters["maskDataBase64"] = json!("corrupt");
            let invalid =
                crate::mask_generation::generate_mask_bitmap(&def, 2, 1, 1.0, (0.0, 0.0), None)
                    .unwrap();
            assert!(invalid.as_raw().iter().all(|v| *v == 0));
        }
    }

    #[test]
    fn rgb16_provenance_rejects_corruption_and_keeps_low_bits() {
        let p = parameters("normals", vec![32769, 32770, 65535], 1, 1, &json!({}));
        let a: SurfaceArtifact = serde_json::from_value(p["surfaceArtifact"].clone()).unwrap();
        let data = p["maskDataBase64"].as_str().unwrap();
        validate_artifact(data, &a).unwrap();
        let bytes = STANDARD.decode(data.split_once(',').unwrap().1).unwrap();
        assert_eq!(
            decode_map(&bytes).unwrap().get_pixel(0, 0).0,
            [32769, 32770, 65535]
        );
        let mut corrupt = a.clone();
        corrupt.map_hash = "0".repeat(64);
        assert!(validate_artifact(data, &corrupt).is_err());
        let mut wrong = bytes;
        wrong[24] = 8;
        assert!(decode_map(&wrong).is_err());
        corrupt = a;
        corrupt.source_width = 100_000_000;
        corrupt.source_height = 2;
        assert!(validate_artifact(data, &corrupt).is_err());
    }

    #[test]
    fn normals_follow_display_direction_and_flips() {
        let mut p = parameters(
            "normals",
            vec![65535, 32768, 32768, 0, 32768, 32768, 32768, 65535, 32768],
            3,
            1,
            &json!({}),
        );
        assert_eq!(selection(&p).unwrap().as_raw(), &[255, 0, 0]);
        p["normalOpposing"] = json!(true);
        assert_eq!(selection(&p).unwrap().as_raw(), &[0, 255, 0]);
        p["normalOpposing"] = json!(false);
        p["flipHorizontal"] = json!(true);
        assert_eq!(selection(&p).unwrap().as_raw(), &[0, 255, 0]);
        p["flipHorizontal"] = json!(false);
        p["orientationSteps"] = json!(1);
        assert_eq!(selection(&p).unwrap().as_raw(), &[0, 0, 255]);
        p["orientationSteps"] = json!(0);
        p["normalAngle"] = json!(90);
        assert_eq!(selection(&p).unwrap().as_raw(), &[0, 0, 255]);
        p["normalAngle"] = json!(0);
        p["rotation"] = json!(90);
        assert_eq!(selection(&p).unwrap().as_raw(), &[0, 0, 255]);
    }

    #[test]
    fn albedo_matches_colour_across_brightness_and_excludes_other_colours() {
        let mut pixels = Vec::new();
        for x in 0..15 {
            pixels.extend(if x < 5 {
                [50000, 0, 0]
            } else if x < 10 {
                [25000, 0, 0]
            } else {
                [0, 50000, 0]
            });
        }
        let mut p = parameters("albedo", pixels, 15, 1, &json!({}));
        p["surfacePointX"] = json!(0.1);
        p["surfacePointY"] = json!(0.5);
        p["surfaceTolerance"] = json!(0.13);
        let map = selection(&p).unwrap();
        assert_eq!(map.get_pixel(2, 0).0[0], 255);
        assert_eq!(map.get_pixel(7, 0).0[0], 255);
        assert_eq!(map.get_pixel(12, 0).0[0], 0);
    }

    #[test]
    fn geometry_signature_survives_json_numbers_and_display_transforms() {
        let a = json!({"transformRotate":0.0,"guidedPerspective":{"vertical":[1.0,2.5]}});
        let mut b = json!({"transformRotate":0,"guidedPerspective":{"vertical":[1,2.5]}});
        assert_eq!(geometry_hash(&a), geometry_hash(&b));
        b["rotation"] = json!(30);
        b["orientationSteps"] = json!(1);
        b["crop"] = json!({"x":20});
        assert_eq!(geometry_hash(&a), geometry_hash(&b));
        b["transformRotate"] = json!(2);
        assert_ne!(geometry_hash(&a), geometry_hash(&b));
        b = a.clone();
        b["aiPatches"] = json!([]);
        assert_ne!(geometry_hash(&a), geometry_hash(&b));
    }

    #[test]
    fn signed_exposure_expansion_zero_identity_and_stale_geometry() {
        let p = parameters("normals", vec![65535, 32768, 32768], 1, 1, &json!({}));
        let mut a = json!({"masks":[mask(p,"normals")]});
        let expanded = render_masks(&a);
        assert_eq!(expanded.len(), 2);
        let positive =
            crate::image_processing::get_mask_adjustments_from_json(&expanded[0].adjustments);
        let negative =
            crate::image_processing::get_mask_adjustments_from_json(&expanded[1].adjustments);
        assert_eq!(positive.exposure, 0.5);
        assert_eq!(negative.exposure, -0.5);
        assert_eq!(a["masks"].as_array().unwrap().len(), 1);
        a["masks"][0]["subMasks"][0]["parameters"]["normalAmount"] = json!(0);
        assert_eq!(render_masks(&a).len(), 1);
        assert_eq!(
            crate::image_processing::get_mask_adjustments_from_json(
                &render_masks(&a)[0].adjustments
            )
            .exposure,
            0.0
        );
        a["transformRotate"] = json!(5);
        let stale = render_masks(&a);
        let bitmap =
            crate::mask_generation::generate_mask_bitmap(&stale[0], 1, 1, 1.0, (0.0, 0.0), None)
                .unwrap();
        assert_eq!(bitmap.as_raw(), &[0]);
        assert!(a["masks"][0]["subMasks"][0]["parameters"]["maskDataBase64"].is_string());
    }

    #[test]
    fn surface_settings_are_off_for_defaults_and_legacy_settings() {
        assert!(!crate::app_settings::AppSettings::default().marigold_surface_enabled);
        let legacy: crate::app_settings::AppSettings = serde_json::from_value(json!({})).unwrap();
        assert!(!legacy.marigold_surface_enabled);
        assert!(std::mem::size_of::<crate::image_processing::AllAdjustments>() <= 65536);
    }

    #[test]
    fn native_shader_parses_and_validates() {
        let module =
            wgpu::naga::front::wgsl::parse_str(include_str!("shaders/shader.wgsl")).unwrap();
        wgpu::naga::valid::Validator::new(
            wgpu::naga::valid::ValidationFlags::all(),
            wgpu::naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
    }
}
