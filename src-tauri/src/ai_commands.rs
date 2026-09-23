use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose};
use image::{GrayImage, ImageFormat};

use crate::ai_connector;
use crate::ai_processing::{
    AiDepthMaskParameters, AiForegroundMaskParameters, AiSkyMaskParameters,
    AiSubjectMaskParameters, CachedDepthMap, generate_image_embeddings, get_or_init_ai_models,
    run_depth_anything_model, run_sam_decoder, run_sky_seg_model, run_u2netp_model,
};
use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::cache_utils::{GEOMETRY_KEYS, calculate_geometry_hash};
use crate::get_cached_full_warped_image;

fn encode_to_base64_png(image: &GrayImage) -> Result<String, String> {
    let mut buf = Cursor::new(Vec::new());
    image
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(format!("data:image/png;base64,{}", base64_str))
}

#[tauri::command]
pub async fn generate_sam21_subject_proposals(
    js_adjustments: serde_json::Value,
    bbox: Option<[f32; 4]>,
    points: Vec<crate::ai_processing::sam21::Point>,
    prior_logits_base64: Option<String>,
    expected_image_hash: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<crate::ai_processing::sam21::ResultSet, String> {
    let image = get_cached_full_warped_image(&state, &js_adjustments)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::ai_processing::sam21::propose(
            &app_handle,
            image.as_ref(),
            bbox,
            &points,
            prior_logits_base64.as_deref(),
            expected_image_hash.as_deref(),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finish_sam21_subject_mask(
    js_adjustments: serde_json::Value,
    expected_image_hash: String,
    logits_base64: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let image = get_cached_full_warped_image(&state, &js_adjustments)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::ai_processing::sam21::finish(image.as_ref(), &expected_image_hash, &logits_base64)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn generate_ai_foreground_mask(
    js_adjustments: serde_json::Value,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiForegroundMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

    let full_mask_image =
        run_u2netp_model(warped_image.as_ref(), &models.u2netp).map_err(|e| e.to_string())?;
    let base64_data = encode_to_base64_png(&full_mask_image)?;

    Ok(AiForegroundMaskParameters {
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[tauri::command]
pub async fn generate_ai_sky_mask(
    js_adjustments: serde_json::Value,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSkyMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

    let full_mask_image =
        run_sky_seg_model(warped_image.as_ref(), &models.sky_seg).map_err(|e| e.to_string())?;
    let base64_data = encode_to_base64_png(&full_mask_image)?;

    Ok(AiSkyMaskParameters {
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_depth_mask(
    js_adjustments: serde_json::Value,
    path: String,
    min_depth: f32,
    max_depth: f32,
    min_fade: f32,
    max_fade: f32,
    feather: f32,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiDepthMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let path_hash = {
        let mut hasher = blake3::Hasher::new();
        hasher.update(path.as_bytes());
        let mut geo_hasher = DefaultHasher::new();
        for key in GEOMETRY_KEYS {
            if let Some(val) = js_adjustments.get(key) {
                key.hash(&mut geo_hasher);
                val.to_string().hash(&mut geo_hasher);
            }
        }
        hasher.update(&geo_hasher.finish().to_le_bytes());
        hasher.finalize().to_hex().to_string()
    };

    let cached_depth = {
        let mut ai_state_lock = state.ai_state.lock().unwrap();
        let ai_state = ai_state_lock.as_mut().unwrap();

        if let Some(cached) = &ai_state.depth_map {
            if cached.path_hash == path_hash {
                cached.clone()
            } else {
                let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
                let depth_img =
                    run_depth_anything_model(warped_image.as_ref(), &models.depth_anything)
                        .map_err(|e| e.to_string())?;
                let new_cache = CachedDepthMap {
                    path_hash: path_hash.clone(),
                    depth_image: depth_img,
                    original_size: (warped_image.width(), warped_image.height()),
                };
                ai_state.depth_map = Some(new_cache.clone());
                new_cache
            }
        } else {
            let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
            let depth_img = run_depth_anything_model(warped_image.as_ref(), &models.depth_anything)
                .map_err(|e| e.to_string())?;
            let new_cache = CachedDepthMap {
                path_hash: path_hash.clone(),
                depth_image: depth_img,
                original_size: (warped_image.width(), warped_image.height()),
            };
            ai_state.depth_map = Some(new_cache.clone());
            new_cache
        }
    };

    let raw_depth_fullres = image::imageops::resize(
        &cached_depth.depth_image,
        cached_depth.original_size.0,
        cached_depth.original_size.1,
        image::imageops::FilterType::Triangle,
    );

    let base64_data = encode_to_base64_png(&raw_depth_fullres)?;

    Ok(AiDepthMaskParameters {
        min_depth,
        max_depth,
        min_fade,
        max_fade,
        feather,
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[tauri::command]
pub async fn generate_full_image_depth_map(
    js_adjustments: serde_json::Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let models = crate::ai_processing::get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
    )
    .await
    .map_err(|e| e.to_string())?;

    let warped_image = crate::get_cached_full_warped_image(&state, &js_adjustments)?;

    let depth_img = crate::ai_processing::run_depth_anything_model(
        warped_image.as_ref(),
        &models.depth_anything,
    )
    .map_err(|e| e.to_string())?;

    let mut buf = std::io::Cursor::new(Vec::new());
    depth_img
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let base64_str = base64::engine::general_purpose::STANDARD.encode(buf.get_ref());

    Ok(format!("data:image/png;base64,{}", base64_str))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_subject_mask(
    js_adjustments: serde_json::Value,
    path: String,
    start_point: (f64, f64),
    end_point: (f64, f64),
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSubjectMaskParameters, String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let path_hash = {
        let mut hasher = blake3::Hasher::new();
        hasher.update(path.as_bytes());
        hasher.update(&calculate_geometry_hash(&js_adjustments).to_le_bytes());
        hasher.finalize().to_hex().to_string()
    };

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;

    let embeddings = {
        let mut ai_state_lock = state.ai_state.lock().unwrap();
        let ai_state = ai_state_lock.as_mut().unwrap();

        if let Some(cached_embeddings) = &ai_state.embeddings {
            if cached_embeddings.path_hash == path_hash {
                cached_embeddings.clone()
            } else {
                let mut new_embeddings =
                    generate_image_embeddings(warped_image.as_ref(), &models.sam_encoder)
                        .map_err(|e| e.to_string())?;
                new_embeddings.path_hash = path_hash.clone();
                ai_state.embeddings = Some(new_embeddings.clone());
                new_embeddings
            }
        } else {
            let mut new_embeddings =
                generate_image_embeddings(warped_image.as_ref(), &models.sam_encoder)
                    .map_err(|e| e.to_string())?;
            new_embeddings.path_hash = path_hash.clone();
            ai_state.embeddings = Some(new_embeddings.clone());
            new_embeddings
        }
    };

    let (img_w, img_h) = embeddings.original_size;

    let (coarse_rotated_w, coarse_rotated_h) = if orientation_steps % 2 == 1 {
        (img_h as f64, img_w as f64)
    } else {
        (img_w as f64, img_h as f64)
    };

    let center = (coarse_rotated_w / 2.0, coarse_rotated_h / 2.0);

    let p1 = start_point;
    let p2 = (start_point.0, end_point.1);
    let p3 = end_point;
    let p4 = (end_point.0, start_point.1);

    let angle_rad = (rotation as f64).to_radians();
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let unrotate = |p: (f64, f64)| {
        let px = p.0 - center.0;
        let py = p.1 - center.1;
        let new_px = px * cos_a + py * sin_a + center.0;
        let new_py = -px * sin_a + py * cos_a + center.1;
        (new_px, new_py)
    };

    let up1 = unrotate(p1);
    let up2 = unrotate(p2);
    let up3 = unrotate(p3);
    let up4 = unrotate(p4);

    let unflip = |p: (f64, f64)| {
        let mut new_px = p.0;
        let mut new_py = p.1;
        if flip_horizontal {
            new_px = coarse_rotated_w - p.0;
        }
        if flip_vertical {
            new_py = coarse_rotated_h - p.1;
        }
        (new_px, new_py)
    };

    let ufp1 = unflip(up1);
    let ufp2 = unflip(up2);
    let ufp3 = unflip(up3);
    let ufp4 = unflip(up4);

    let un_coarse_rotate = |p: (f64, f64)| -> (f64, f64) {
        match orientation_steps {
            0 => p,
            1 => (p.1, img_h as f64 - p.0),
            2 => (img_w as f64 - p.0, img_h as f64 - p.1),
            3 => (img_w as f64 - p.1, p.0),
            _ => p,
        }
    };

    let ucrp1 = un_coarse_rotate(ufp1);
    let ucrp2 = un_coarse_rotate(ufp2);
    let ucrp3 = un_coarse_rotate(ufp3);
    let ucrp4 = un_coarse_rotate(ufp4);

    let min_x = ucrp1.0.min(ucrp2.0).min(ucrp3.0).min(ucrp4.0);
    let min_y = ucrp1.1.min(ucrp2.1).min(ucrp3.1).min(ucrp4.1);
    let max_x = ucrp1.0.max(ucrp2.0).max(ucrp3.0).max(ucrp4.0);
    let max_y = ucrp1.1.max(ucrp2.1).max(ucrp3.1).max(ucrp4.1);

    let unrotated_start_point = (min_x, min_y);
    let unrotated_end_point = (max_x, max_y);

    let mask_bitmap = run_sam_decoder(
        &models.sam_decoder,
        &embeddings,
        unrotated_start_point,
        unrotated_end_point,
        Some(warped_image.as_ref()),
    )
    .map_err(|e| e.to_string())?;

    let base64_data = encode_to_base64_png(&mask_bitmap)?;

    Ok(AiSubjectMaskParameters {
        start_x: start_point.0,
        start_y: start_point.1,
        end_x: end_point.0,
        end_y: end_point.1,
        mask_data_base64: Some(base64_data),
        rotation: Some(rotation),
        flip_horizontal: Some(flip_horizontal),
        flip_vertical: Some(flip_vertical),
        orientation_steps: Some(orientation_steps),
    })
}

#[tauri::command]
pub async fn precompute_ai_subject_mask(
    js_adjustments: serde_json::Value,
    path: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let path_hash = {
        let mut hasher = blake3::Hasher::new();
        hasher.update(path.as_bytes());
        hasher.update(&calculate_geometry_hash(&js_adjustments).to_le_bytes());
        hasher.finalize().to_hex().to_string()
    };

    let mut ai_state_lock = state.ai_state.lock().unwrap();
    let ai_state = ai_state_lock.as_mut().unwrap();

    if let Some(cached_embeddings) = &ai_state.embeddings
        && cached_embeddings.path_hash == path_hash
    {
        return Ok(());
    }

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    let mut new_embeddings = generate_image_embeddings(warped_image.as_ref(), &models.sam_encoder)
        .map_err(|e| e.to_string())?;

    new_embeddings.path_hash = path_hash.clone();
    ai_state.embeddings = Some(new_embeddings);

    Ok(())
}

#[tauri::command]
pub async fn check_ai_connector_status(app_handle: tauri::AppHandle) {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let is_connected = if let Some(address) = settings.ai_connector_address {
        ai_connector::check_status(&address).await.unwrap_or(false)
    } else {
        false
    };
    use tauri::Emitter;
    let _ = app_handle.emit(
        "ai-connector-status-update",
        serde_json::json!({ "connected": is_connected }),
    );
}

#[tauri::command]
pub async fn test_ai_connector_connection(address: String) -> Result<(), String> {
    match ai_connector::check_status(&address).await {
        Ok(true) => Ok(()),
        Ok(false) => Err("Server reachable but returned bad health status".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerationCapabilities {
    #[serde(default)]
    seed: bool,
    #[serde(alias = "default_profile")]
    default_profile: String,
    profiles: Vec<AiGenerationProfile>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerationProfile {
    id: String,
    label: String,
    #[serde(alias = "default_megapixels")]
    default_megapixels: f64,
    megapixels: Vec<f64>,
    #[serde(default = "prompt_required_by_default", alias = "requires_prompt")]
    requires_prompt: bool,
    #[serde(default, alias = "reference_image")]
    reference_image: bool,
}

fn prompt_required_by_default() -> bool {
    true
}

fn parse_generation_capabilities(
    value: serde_json::Value,
) -> Result<Option<AiGenerationCapabilities>, String> {
    if value.get("protocol_version").and_then(|v| v.as_u64()) != Some(2) {
        return Ok(None);
    }
    let mut capabilities: AiGenerationCapabilities =
        serde_json::from_value(value.get("generation").cloned().unwrap_or_default())
            .map_err(|_| "The connector returned incomplete workflow options".to_string())?;
    if capabilities.profiles.is_empty() || capabilities.profiles.len() > 64 {
        return Err("The connector must advertise between 1 and 64 workflows".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for profile in &mut capabilities.profiles {
        profile.label = profile.label.trim().to_string();
        if !ids.insert(profile.id.clone())
            || profile.label.is_empty()
            || profile.label.chars().count() > 120
            || profile.label.chars().any(char::is_control)
            || profile.megapixels.is_empty()
            || profile.megapixels.len() > 32
        {
            return Err("The connector returned invalid workflow choices".to_string());
        }
        ai_connector::GenerationOptions {
            profile: Some(profile.id.clone()),
            megapixels: Some(profile.default_megapixels),
            ..Default::default()
        }
        .validate()
        .map_err(|e| e.to_string())?;
        for &mp in &profile.megapixels {
            ai_connector::GenerationOptions {
                megapixels: Some(mp),
                ..Default::default()
            }
            .validate()
            .map_err(|e| e.to_string())?;
        }
        if !profile
            .megapixels
            .iter()
            .any(|mp| (*mp - profile.default_megapixels).abs() <= 1e-9)
        {
            return Err("The connector's default detail is unavailable".to_string());
        }
        profile.megapixels.sort_by(f64::total_cmp);
        profile.megapixels.dedup_by(|a, b| (*a - *b).abs() <= 1e-9);
    }
    if !ids.contains(&capabilities.default_profile) {
        return Err("The connector's default workflow is unavailable".to_string());
    }
    Ok(Some(capabilities))
}

#[tauri::command]
pub async fn get_ai_connector_capabilities(
    address: String,
    token: Option<String>,
) -> Result<Option<AiGenerationCapabilities>, String> {
    let mut request = reqwest::Client::new()
        .get(format!(
            "http://{}/capabilities",
            address.trim().trim_end_matches('/')
        ))
        .timeout(std::time::Duration::from_secs(5));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Could not reach the connector to load workflow options".to_string())?;
    if matches!(response.status().as_u16(), 404 | 405) {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "Could not load workflow options (HTTP {})",
            response.status().as_u16()
        ));
    }
    let value = response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| "The connector returned unreadable workflow options".to_string())?;
    parse_generation_capabilities(value)
}

#[cfg(test)]
mod generation_capabilities_tests {
    use super::{get_ai_connector_capabilities, parse_generation_capabilities};
    use serde_json::json;

    fn valid() -> serde_json::Value {
        json!({"protocol_version":2,"generation":{"seed":true,"default_profile":"balanced",
            "profiles":[{"id":"balanced","label":" Balanced editing ","default_megapixels":1,"megapixels":[2,1,1]}]}})
    }

    #[test]
    fn generation_ui_capabilities_normalize_and_serialize() {
        let result = parse_generation_capabilities(valid()).unwrap().unwrap();
        let output = serde_json::to_value(result).unwrap();
        assert_eq!(output["defaultProfile"], "balanced");
        assert_eq!(output["profiles"][0]["label"], "Balanced editing");
        assert_eq!(output["profiles"][0]["defaultMegapixels"], 1.0);
        assert_eq!(output["profiles"][0]["requiresPrompt"], true);
        assert_eq!(output["profiles"][0]["megapixels"], json!([1.0, 2.0]));
        let remove = json!({"protocol_version":2,"generation":{"seed":true,"default_profile":"qwen21-remove-v1",
            "profiles":[{"id":"qwen21-remove-v1","label":"Qwen Remove","default_megapixels":1,
                         "megapixels":[1,2],"requires_prompt":false}]}});
        let output =
            serde_json::to_value(parse_generation_capabilities(remove).unwrap().unwrap()).unwrap();
        assert_eq!(output["profiles"][0]["requiresPrompt"], false);
        assert!(
            parse_generation_capabilities(json!({"protocol_version":1}))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn generation_ui_capabilities_reject_invalid_choices() {
        for (field, value) in [
            ("id", json!("../model")),
            ("label", json!("")),
            ("default_megapixels", json!(4)),
            ("megapixels", json!([0])),
        ] {
            let mut input = valid();
            input["generation"]["profiles"][0][field] = value;
            assert!(parse_generation_capabilities(input).is_err(), "{field}");
        }
        let mut input = valid();
        input["generation"]["default_profile"] = json!("missing");
        assert!(parse_generation_capabilities(input).is_err());
        let mut input = valid();
        let duplicate = input["generation"]["profiles"][0].clone();
        input["generation"]["profiles"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(parse_generation_capabilities(input).is_err());
    }

    #[tokio::test]
    async fn generation_ui_capabilities_legacy_http_and_auth() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("{}/", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0; 4096];
            let count = stream.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..count]).to_lowercase();
            assert!(request.starts_with("get /capabilities "));
            assert!(request.contains("authorization: bearer fixture-token"));
            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        assert!(
            get_ai_connector_capabilities(address, Some("fixture-token".into()))
                .await
                .unwrap()
                .is_none()
        );
        server.join().unwrap();
    }
}
