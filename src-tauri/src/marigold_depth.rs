use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, GrayImage, ImageFormat, Luma, imageops::FilterType};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Cursor, time::Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DepthArtifact {
    pub version: u8,
    pub source_width: u32,
    pub source_height: u32,
    pub source_hash: String,
    pub geometry_hash: String,
    pub workflow_hash: String,
    pub map_hash: String,
    pub profile: String,
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn sync_orientation(adjustments: &mut Value) {
    let geometry = [
        ("rotation", adjustments["rotation"].clone()),
        ("orientationSteps", adjustments["orientationSteps"].clone()),
        ("flipHorizontal", adjustments["flipHorizontal"].clone()),
        ("flipVertical", adjustments["flipVertical"].clone()),
    ];
    if let Some(masks) = adjustments["masks"].as_array_mut() {
        for mask in masks {
            if let Some(parts) = mask["subMasks"].as_array_mut() {
                for part in parts {
                    if part["type"] == "ai-depth"
                        && part["parameters"]["depthProvider"] == "marigold"
                    {
                        for (key, value) in &geometry {
                            if !value.is_null() {
                                part["parameters"][*key] = value.clone();
                            }
                        }
                    }
                }
            }
        }
    }
}

fn endpoint(address: &str) -> Result<String, String> {
    let text = if address.contains("://") {
        address.to_owned()
    } else {
        format!("http://{address}")
    };
    let url = reqwest::Url::parse(&text).map_err(|_| "Invalid depth service address")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Depth service requires an HTTP(S) address without credentials".into());
    }
    Ok(text.trim_end_matches('/').to_owned())
}

fn connection_error(error: reqwest::Error) -> String {
    log::warn!("Marigold connector request failed: {error:?}");
    if error.is_timeout() {
        "The AI connector took too long to respond. Check its connection and GPU queue.".into()
    } else {
        "Could not reach the AI connector. Check its address and connection.".into()
    }
}

async fn response_json(mut response: reqwest::Response) -> Result<Value, String> {
    let success = response.status().is_success();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err("Depth response exceeds 16 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid depth service response")?;
    if !success {
        return Err(value["detail"]
            .as_str()
            .unwrap_or("Depth service failed")
            .chars()
            .take(1200)
            .collect());
    }
    Ok(value)
}

#[tauri::command]
pub async fn test_marigold_depth_connection(address: String) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let value = response_json(
        client
            .get(format!("{}/depth/capabilities", endpoint(&address)?))
            .send()
            .await
            .map_err(connection_error)?,
    )
    .await?;
    if value["protocol_version"] != 1 || value["provider"] != "marigold" || value["ready"] != true {
        return Err("Incompatible or unavailable Marigold depth service".into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn generate_marigold_depth_mask(
    js_adjustments: Value,
    path: String,
    state: tauri::State<'_, crate::app_state::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Value, String> {
    let settings = crate::app_settings::load_settings(app_handle)?;
    if !settings.marigold_depth_enabled {
        return Err("Marigold depth is disabled. Enable the optional feature first.".into());
    }
    let address = settings
        .ai_connector_address
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Configure the AI connector address")?;
    // Capture the analysis pixels before the network await; this never initializes local AI models.
    if state
        .original_image
        .lock()
        .map_err(|_| "Image state is unavailable")?
        .as_ref()
        .is_none_or(|image| image.path != path)
    {
        return Err("Photo changed before depth analysis started".into());
    }
    let warped = crate::get_cached_full_warped_image(&state, &js_adjustments)?;
    let (width, height) = (warped.width(), warped.height());
    let analysis = warped.resize(1024, 1024, FilterType::Lanczos3).to_rgb8();
    if analysis.width().min(analysis.height()) < 64 {
        return Err("Marigold requires an analysis image at least 64 pixels on each edge".into());
    }
    let mut png = Cursor::new(Vec::new());
    analysis
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(480))
        .build()
        .map_err(|e| e.to_string())?;
    let source_hash = sha256(png.get_ref());
    let part = reqwest::multipart::Part::bytes(png.into_inner())
        .file_name("analysis.png")
        .mime_str("image/png")
        .map_err(|e| e.to_string())?;
    let response = response_json(
        client
            .post(format!("{}/depth", endpoint(address)?))
            .multipart(reqwest::multipart::Form::new().part("file", part))
            .send()
            .await
            .map_err(connection_error)?,
    )
    .await?;
    let encoded = response["depth_png_base64"]
        .as_str()
        .ok_or("Missing depth map")?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid depth map encoding")?;
    let depth = decode_depth(&bytes)?;
    let metadata = &response["metadata"];
    let hash = |key: &str| -> Result<String, String> {
        let value = metadata[key].as_str().ok_or("Missing depth provenance")?;
        if value.len() != 64
            || !value
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err("Invalid depth provenance hash".into());
        }
        Ok(value.into())
    };
    if metadata["profile"] != "marigold-v2-q4-v1"
        || metadata["space"] != "relative-log-depth"
        || metadata["direction"] != "near-bright"
        || metadata["width"] != depth.width()
        || metadata["height"] != depth.height()
    {
        return Err("Incompatible depth profile or dimensions".into());
    }
    if hash("source_sha256")? != source_hash || hash("map_sha256")? != sha256(&bytes) {
        return Err("Depth artifact checksum mismatch".into());
    }
    let artifact = DepthArtifact {
        version: 1,
        source_width: width,
        source_height: height,
        source_hash: hash("source_sha256")?,
        geometry_hash: blake3::hash(serde_json::to_string(&js_adjustments).unwrap().as_bytes())
            .to_hex()
            .to_string(),
        workflow_hash: hash("workflow_sha256")?,
        map_hash: hash("map_sha256")?,
        profile: "marigold-v2-q4-v1".into(),
    };
    Ok(
        json!({"depthProvider":"marigold", "depthArtifact":artifact, "maskDataBase64":format!("data:image/png;base64,{encoded}"),
        "rotation":js_adjustments["rotation"].as_f64().unwrap_or(0.0), "flipHorizontal":js_adjustments["flipHorizontal"].as_bool().unwrap_or(false),
        "flipVertical":js_adjustments["flipVertical"].as_bool().unwrap_or(false), "orientationSteps":js_adjustments["orientationSteps"].as_u64().unwrap_or(0)}),
    )
}

fn decode_depth(bytes: &[u8]) -> Result<image::ImageBuffer<Luma<u16>, Vec<u16>>, String> {
    if bytes.len() < 33
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || bytes[24] != 16
        || ![0, 2].contains(&bytes[25])
    {
        return Err("Expected a 16-bit depth PNG".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 || width as u64 * height as u64 > 1_048_576 {
        return Err("Depth map exceeds the supported analysis size".into());
    }
    let image =
        image::load_from_memory_with_format(bytes, ImageFormat::Png).map_err(|e| e.to_string())?;
    if let DynamicImage::ImageRgb16(rgb) = &image
        && rgb.pixels().any(|p| p[0] != p[1] || p[0] != p[2])
    {
        return Err("Depth PNG channels differ".into());
    }
    Ok(image.to_luma16())
}

pub fn validate_artifact(data: &str, artifact: &DepthArtifact) -> Result<(), String> {
    if artifact.version != 1
        || artifact.profile != "marigold-v2-q4-v1"
        || artifact.source_width == 0
        || artifact.source_height == 0
        || artifact.source_width as u64 * artifact.source_height as u64 > 100_000_000
    {
        return Err("Invalid Marigold depth artifact".into());
    }
    let bytes = STANDARD
        .decode(data.split_once(',').map_or(data, |(_, v)| v))
        .map_err(|_| "Invalid depth map encoding")?;
    decode_depth(&bytes)?;
    if artifact.map_hash != sha256(&bytes) {
        return Err("Depth map checksum mismatch".into());
    }
    Ok(())
}

pub fn selection(
    data: &str,
    artifact: &DepthArtifact,
    min: f32,
    max: f32,
    min_fade: f32,
    max_fade: f32,
) -> Option<GrayImage> {
    validate_artifact(data, artifact).ok()?;
    let bytes = STANDARD
        .decode(data.split_once(',').map_or(data, |(_, v)| v))
        .ok()?;
    let depth = decode_depth(&bytes).ok()?;
    let smooth = |a: f32, b: f32, v: f32| {
        let t = ((v - a) / (b - a).max(0.0001)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let mask = GrayImage::from_fn(depth.width(), depth.height(), |x, y| {
        let value = depth.get_pixel(x, y)[0] as f32 * (100.0 / 65535.0);
        let lower = if min_fade == 0.0 {
            if value >= min { 1.0 } else { 0.0 }
        } else {
            smooth(min - min_fade, min, value)
        };
        let upper = if max_fade == 0.0 {
            if value <= max { 1.0 } else { 0.0 }
        } else {
            1.0 - smooth(max, max + max_fade, value)
        };
        Luma([(lower * upper * 255.0).round() as u8])
    });
    Some(image::imageops::resize(
        &mask,
        artifact.source_width,
        artifact.source_height,
        FilterType::Triangle,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(values: &[u16]) -> (String, DepthArtifact) {
        let depth =
            image::ImageBuffer::<Luma<u16>, _>::from_raw(values.len() as u32, 1, values.to_vec())
                .unwrap();
        let mut bytes = Cursor::new(Vec::new());
        depth.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let artifact = DepthArtifact {
            version: 1,
            source_width: values.len() as u32,
            source_height: 1,
            source_hash: "a".repeat(64),
            geometry_hash: "b".repeat(64),
            workflow_hash: "c".repeat(64),
            map_hash: sha256(bytes.get_ref()),
            profile: "marigold-v2-q4-v1".into(),
        };
        (
            format!("data:image/png;base64,{}", STANDARD.encode(bytes.get_ref())),
            artifact,
        )
    }
    #[test]
    fn precise_selection_is_not_quantized_or_weighted_by_distance() {
        let (data, artifact) = fixture(&[0, 32700, 32800, 65535]);
        let all = selection(&data, &artifact, 0.0, 100.0, 0.0, 0.0).unwrap();
        assert_eq!(all.as_raw(), &[255, 255, 255, 255]);
        let narrow = selection(&data, &artifact, 49.8, 49.95, 0.0, 0.0).unwrap();
        assert_eq!(narrow.as_raw(), &[0, 255, 0, 0]);
        let serialized = serde_json::to_string(&artifact).unwrap();
        let restored = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            selection(&data, &restored, 49.8, 49.95, 0.0, 0.0),
            Some(narrow)
        );
    }
    #[test]
    fn corrupted_or_mismatched_saved_artifact_is_rejected() {
        let (data, mut artifact) = fixture(&[12345]);
        artifact.map_hash = "0".repeat(64);
        assert!(validate_artifact(&data, &artifact).is_err());
        artifact.source_width = 100000;
        artifact.source_height = 100000;
        assert!(validate_artifact(&data, &artifact).is_err());
    }
    #[test]
    fn saved_mask_tracks_orientation_without_changing_builtin_masks() {
        let (data, mut artifact) = fixture(&[0, 0, 65535, 65535, 0, 0, 65535, 65535]);
        artifact.source_width = 8;
        artifact.source_height = 4;
        let builtin = json!({"type":"ai-depth","parameters":{"orientationSteps":0}});
        let mut adjustments = json!({"rotation":0,"orientationSteps":1,"flipHorizontal":true,"flipVertical":false,
            "masks":[{"id":"mask","name":"Depth","visible":true,"invert":false,"adjustments":{},"subMasks":[
                {"id":"part","type":"ai-depth","mode":"additive","visible":true,"parameters":{
                    "depthProvider":"marigold","depthArtifact":artifact,"maskDataBase64":data,"orientationSteps":0,
                    "minDepth":50,"maxDepth":100,"minFade":0,"maxFade":0,"feather":0}},builtin.clone()]}]});
        sync_orientation(&mut adjustments);
        assert_eq!(adjustments["masks"][0]["subMasks"][1], builtin);
        adjustments["masks"][0]["subMasks"]
            .as_array_mut()
            .unwrap()
            .pop();
        let mask = serde_json::from_value(adjustments["masks"][0].clone()).unwrap();
        let result =
            crate::mask_generation::generate_mask_bitmap(&mask, 4, 8, 1.0, (0.0, 0.0), None)
                .unwrap();
        // The selected vertical source bands become horizontal bands after rotation.
        assert_eq!(result.get_pixel(1, 2)[0], 255);
        assert_eq!(result.get_pixel(2, 2)[0], 255);
        assert_eq!(result.get_pixel(1, 4)[0], 0);
        assert_eq!(result.get_pixel(2, 4)[0], 0);
    }
    #[test]
    fn optional_depth_is_disabled_in_default_and_legacy_settings() {
        let original = crate::app_settings::AppSettings::default();
        assert!(!original.marigold_depth_enabled);
        let mut json = serde_json::to_value(original).unwrap();
        json.as_object_mut().unwrap().remove("marigoldDepthEnabled");
        let legacy: crate::app_settings::AppSettings = serde_json::from_value(json).unwrap();
        assert!(!legacy.marigold_depth_enabled);
    }
}
