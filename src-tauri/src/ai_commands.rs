use crate::app_state::AiTaskGuard;
use crate::effect_maps::EffectMapKind;
use crate::face_masking::{FaceAnalysis, FacePart, analyze_faces, compose_face_mask};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::sync::{Arc, Mutex};

use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, GrayImage, ImageFormat};
use serde::Serialize;
use serde_json::{Value, json};

use crate::ai_connector;
use crate::ai_processing::{
    AiDepthMaskParameters, AiFaceMaskParameters, AiForegroundMaskParameters, AiMaskModel, AiModels,
    AiSkyMaskParameters, AiState, AiSubjectMaskParameters, AiTextMaskParameters, CachedDepthMap,
    ESAM3_FACE_SCORE_THRESHOLD, ESAM3_SKY_REFINE_EPS, ESAM3_SKY_SCORE_THRESHOLD,
    ESAM3_TEXT_REFINE_EPS, ESAM3_TEXT_SCORE_THRESHOLD, Esam3Features, ImageEmbeddings,
    generate_image_embeddings, get_or_init_ai_models, run_birefnet_model, run_depth_anything_model,
    run_esam3_boxes, run_esam3_decoder, run_esam3_image_encoder, run_esam3_zoomed_decoder,
    run_sam_decoder,
};
use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::cache_utils::GEOMETRY_KEYS;
use crate::get_cached_full_warped_image;

const NO_FOREGROUND_FOUND: &str = "No foreground found";
const NO_SKY_FOUND: &str = "No sky found";
const NO_MATCH_FOUND: &str = "No match found for";
const NO_FACES_FOUND: &str = "No faces found";
const NO_RESULT_ERRORS: [&str; 4] = [
    NO_FOREGROUND_FOUND,
    NO_SKY_FOUND,
    NO_MATCH_FOUND,
    NO_FACES_FOUND,
];

fn is_no_result_error(error: &str) -> bool {
    NO_RESULT_ERRORS
        .iter()
        .any(|prefix| error.starts_with(prefix))
}

#[tauri::command]
pub fn cancel_ai_task(task_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let tasks = state.active_ai_tasks.lock().unwrap();
    if let Some(token) = tasks.get(&task_id) {
        token.cancel();
    }
    Ok(())
}

fn encode_to_base64_png(image: &GrayImage) -> Result<String, String> {
    let mut buf = Cursor::new(Vec::new());
    image
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(format!("data:image/png;base64,{}", base64_str))
}

#[derive(Clone, Copy)]
pub struct MaskTransform {
    pub rotation: f32,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub orientation_steps: u8,
}

impl MaskTransform {
    pub fn from_adjustments(adjustments: &serde_json::Value) -> Self {
        Self {
            rotation: adjustments["rotation"].as_f64().unwrap_or(0.0) as f32,
            flip_horizontal: adjustments["flipHorizontal"].as_bool().unwrap_or(false),
            flip_vertical: adjustments["flipVertical"].as_bool().unwrap_or(false),
            orientation_steps: adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8,
        }
    }

    pub fn box_space(&self, (width, height): (u32, u32)) -> (u32, u32) {
        if self.orientation_steps % 2 == 1 {
            (height, width)
        } else {
            (width, height)
        }
    }
}

pub fn to_json<T: Serialize>(params: T) -> Result<Value, String> {
    serde_json::to_value(params).map_err(|e| e.to_string())
}

pub fn or_empty_mask(
    result: Result<Value, String>,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<(Value, Option<String>), String> {
    match result {
        Err(error) if is_no_result_error(&error) => {
            let mut params = json!({
                "maskDataBase64": encode_to_base64_png(&GrayImage::new(1, 1))?,
                "rotation": transform.rotation,
                "flipHorizontal": transform.flip_horizontal,
                "flipVertical": transform.flip_vertical,
                "orientationSteps": transform.orientation_steps,
            });
            if let Some(ai_source) = ai_source {
                params["aiSource"] = json!(ai_source);
            }
            Ok((params, Some(error)))
        }
        result => result.map(|params| (params, None)),
    }
}

fn mask_command_result(
    result: Result<Value, String>,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<Value, String> {
    let (mut params, no_result) = or_empty_mask(result, transform, ai_source)?;
    if let Some(error) = no_result {
        params["noResult"] = json!(error);
    }
    Ok(params)
}

pub fn ai_cache_key(path: &str, adjustments: &serde_json::Value) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(path.as_bytes());
    let mut geo_hasher = DefaultHasher::new();
    for key in GEOMETRY_KEYS {
        if let Some(val) = adjustments.get(key) {
            key.hash(&mut geo_hasher);
            val.to_string().hash(&mut geo_hasher);
        }
    }
    hasher.update(&geo_hasher.finish().to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

fn loaded_source_id(state: &tauri::State<'_, AppState>) -> Option<String> {
    let loaded = state.original_image.lock().unwrap().clone()?;
    crate::ai_jobs::source_id_for(&loaded.path)
}

fn check_cancelled(guard: &Option<AiTaskGuard>) -> Result<(), String> {
    if guard.as_ref().is_some_and(|g| g.token.is_cancelled()) {
        return Err("Task cancelled".to_string());
    }
    Ok(())
}

pub fn generate_foreground_mask(
    models: &AiModels,
    warped_image: &DynamicImage,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiForegroundMaskParameters, String> {
    let mask = run_birefnet_model(
        warped_image,
        &*models.birefnet().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if mask.iter().all(|&v| v < 128) {
        return Err(NO_FOREGROUND_FOUND.to_string());
    }

    Ok(AiForegroundMaskParameters {
        mask_data_base64: Some(encode_to_base64_png(&mask)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        ai_source,
    })
}

fn cached_esam3_features(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
) -> Result<Arc<Esam3Features>, String> {
    if let Some(cached) = ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.esam3_features.clone())
        .filter(|cached| cached.path_hash == cache_key)
    {
        return Ok(cached);
    }

    let mut features = run_esam3_image_encoder(
        warped_image,
        &*models.esam3_image_encoder().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    features.path_hash = cache_key.to_string();
    let features = Arc::new(features);

    if let Some(state) = ai_state.lock().unwrap().as_mut() {
        state.esam3_features = Some(features.clone());
    }
    Ok(features)
}

pub fn generate_sky_mask(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiSkyMaskParameters, String> {
    let features = cached_esam3_features(ai_state, models, cache_key, warped_image)?;
    let prompt = models.esam3_sky_prompt().map_err(|e| e.to_string())?;
    let mask = run_esam3_decoder(
        &*models.esam3_decoder().map_err(|e| e.to_string())?,
        &features,
        &prompt,
        warped_image,
        ESAM3_SKY_SCORE_THRESHOLD,
        ESAM3_SKY_REFINE_EPS,
    )
    .map_err(|e| e.to_string())?
    .ok_or_else(|| NO_SKY_FOUND.to_string())?;

    Ok(AiSkyMaskParameters {
        mask_data_base64: Some(encode_to_base64_png(&mask)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        ai_source,
    })
}

pub fn generate_text_mask(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    prompt: &str,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiTextMaskParameters, String> {
    let features = cached_esam3_features(ai_state, models, cache_key, warped_image)?;
    let text_prompt = models
        .esam3_text_prompt(prompt)
        .map_err(|e| e.to_string())?;
    let mask = run_esam3_zoomed_decoder(
        &*models.esam3_image_encoder().map_err(|e| e.to_string())?,
        &*models.esam3_decoder().map_err(|e| e.to_string())?,
        &features,
        &text_prompt,
        warped_image,
        ESAM3_TEXT_SCORE_THRESHOLD,
        ESAM3_TEXT_REFINE_EPS,
    )
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("{} \"{}\"", NO_MATCH_FOUND, prompt.trim()))?;

    Ok(AiTextMaskParameters {
        prompt: prompt.to_string(),
        mask_data_base64: Some(encode_to_base64_png(&mask)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        ai_source,
    })
}

fn cached_face_analysis(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    transform: MaskTransform,
) -> Result<Arc<FaceAnalysis>, String> {
    if let Some(cached) = ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.face_analysis.clone())
        .filter(|cached| cached.path_hash == cache_key)
    {
        return Ok(cached);
    }

    let features = cached_esam3_features(ai_state, models, cache_key, warped_image)?;
    let detections = run_esam3_boxes(
        &*models.esam3_decoder().map_err(|e| e.to_string())?,
        &features,
        &*models.esam3_face_prompt().map_err(|e| e.to_string())?,
        ESAM3_FACE_SCORE_THRESHOLD,
    )
    .map_err(|e| e.to_string())?;
    let analysis = Arc::new(
        analyze_faces(
            warped_image,
            &detections,
            &*models.face_landmarks().map_err(|e| e.to_string())?,
            &*models.face_segmenter().map_err(|e| e.to_string())?,
            -(transform.orientation_steps as f32) * std::f32::consts::FRAC_PI_2,
            cache_key.to_string(),
        )
        .map_err(|e| e.to_string())?,
    );

    if let Some(state) = ai_state.lock().unwrap().as_mut() {
        state.face_analysis = Some(analysis.clone());
    }
    Ok(analysis)
}

pub fn generate_face_mask(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    parts: &[String],
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiFaceMaskParameters, String> {
    let analysis = cached_face_analysis(ai_state, models, cache_key, warped_image, transform)?;
    if analysis.faces.is_empty() {
        return Err(NO_FACES_FOUND.to_string());
    }
    let face_parts: Vec<FacePart> = parts.iter().filter_map(|p| FacePart::from_id(p)).collect();
    let mask = compose_face_mask(warped_image, &analysis, &face_parts);

    Ok(AiFaceMaskParameters {
        parts: parts.to_vec(),
        mask_data_base64: Some(encode_to_base64_png(&mask)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        ai_source,
    })
}

fn cached_depth_estimate(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
) -> Result<CachedDepthMap, String> {
    if let Some(cached) = ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.depth_map.clone())
        .filter(|cached| cached.path_hash == cache_key)
    {
        return Ok(cached);
    }

    let depth_image = run_depth_anything_model(
        warped_image,
        &*models.depth_anything().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let depth = CachedDepthMap {
        path_hash: cache_key.to_string(),
        depth_image,
        original_size: warped_image.dimensions(),
    };
    if let Some(state) = ai_state.lock().unwrap().as_mut() {
        state.depth_map = Some(depth.clone());
    }
    Ok(depth)
}

pub fn generate_depth_mask(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    params: AiDepthMaskParameters,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiDepthMaskParameters, String> {
    let depth = cached_depth_estimate(ai_state, models, cache_key, warped_image)?;
    let raw_depth_fullres = image::imageops::resize(
        &depth.depth_image,
        depth.original_size.0,
        depth.original_size.1,
        image::imageops::FilterType::Triangle,
    );

    Ok(AiDepthMaskParameters {
        mask_data_base64: Some(encode_to_base64_png(&raw_depth_fullres)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        ai_source,
        ..params
    })
}

fn cached_image_embeddings(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
) -> Result<ImageEmbeddings, String> {
    if let Some(cached) = ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.embeddings.clone())
        .filter(|cached| cached.path_hash == cache_key)
    {
        return Ok(cached);
    }

    let mut embeddings = generate_image_embeddings(
        warped_image,
        &*models.sam_encoder().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    embeddings.path_hash = cache_key.to_string();

    if let Some(state) = ai_state.lock().unwrap().as_mut() {
        state.embeddings = Some(embeddings.clone());
    }
    Ok(embeddings)
}

fn unrotate_box(
    start_point: (f64, f64),
    end_point: (f64, f64),
    (img_w, img_h): (u32, u32),
    transform: MaskTransform,
) -> ((f64, f64), (f64, f64)) {
    let (coarse_rotated_w, coarse_rotated_h) = {
        let (w, h) = transform.box_space((img_w, img_h));
        (w as f64, h as f64)
    };
    let center = (coarse_rotated_w / 2.0, coarse_rotated_h / 2.0);

    let angle_rad = (transform.rotation as f64).to_radians();
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let unrotate = |p: (f64, f64)| {
        let px = p.0 - center.0;
        let py = p.1 - center.1;
        (
            px * cos_a + py * sin_a + center.0,
            -px * sin_a + py * cos_a + center.1,
        )
    };

    let unflip = |p: (f64, f64)| {
        let mut new_px = p.0;
        let mut new_py = p.1;
        if transform.flip_horizontal {
            new_px = coarse_rotated_w - p.0;
        }
        if transform.flip_vertical {
            new_py = coarse_rotated_h - p.1;
        }
        (new_px, new_py)
    };

    let un_coarse_rotate = |p: (f64, f64)| -> (f64, f64) {
        match transform.orientation_steps {
            0 => p,
            1 => (p.1, img_h as f64 - p.0),
            2 => (img_w as f64 - p.0, img_h as f64 - p.1),
            3 => (img_w as f64 - p.1, p.0),
            _ => p,
        }
    };

    let corners = [
        start_point,
        (start_point.0, end_point.1),
        end_point,
        (end_point.0, start_point.1),
    ]
    .map(|p| un_coarse_rotate(unflip(unrotate(p))));

    let min_x = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let min_y = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_x = corners
        .iter()
        .map(|p| p.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = corners
        .iter()
        .map(|p| p.1)
        .fold(f64::NEG_INFINITY, f64::max);

    ((min_x, min_y), (max_x, max_y))
}

#[allow(clippy::too_many_arguments)]
pub fn generate_subject_mask(
    ai_state: &Mutex<Option<AiState>>,
    models: &AiModels,
    cache_key: &str,
    warped_image: &DynamicImage,
    start_point: (f64, f64),
    end_point: (f64, f64),
    skip_refinement: bool,
    transform: MaskTransform,
    ai_source: Option<String>,
) -> Result<AiSubjectMaskParameters, String> {
    let embeddings = cached_image_embeddings(ai_state, models, cache_key, warped_image)?;
    let (unrotated_start, unrotated_end) =
        unrotate_box(start_point, end_point, embeddings.original_size, transform);

    let mask_bitmap = run_sam_decoder(
        &*models.sam_decoder().map_err(|e| e.to_string())?,
        &embeddings,
        unrotated_start,
        unrotated_end,
        (!skip_refinement).then_some(warped_image),
    )
    .map_err(|e| e.to_string())?;

    let (box_space_width, box_space_height) = transform.box_space(embeddings.original_size);

    Ok(AiSubjectMaskParameters {
        start_x: start_point.0,
        start_y: start_point.1,
        end_x: end_point.0,
        end_y: end_point.1,
        mask_data_base64: Some(encode_to_base64_png(&mask_bitmap)?),
        rotation: Some(transform.rotation),
        flip_horizontal: Some(transform.flip_horizontal),
        flip_vertical: Some(transform.flip_vertical),
        orientation_steps: Some(transform.orientation_steps),
        box_space_width: Some(box_space_width),
        box_space_height: Some(box_space_height),
        ai_source,
    })
}

#[allow(clippy::too_many_arguments)]
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
#[allow(clippy::too_many_arguments)]
pub async fn generate_ai_foreground_mask(
    js_adjustments: serde_json::Value,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Value, String> {
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Foreground,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let ai_source = loaded_source_id(&state);
    let params = mask_command_result(
        generate_foreground_mask(&models, &warped_image, transform, ai_source.clone())
            .and_then(to_json),
        transform,
        ai_source,
    )?;
    check_cancelled(&guard)?;
    Ok(params)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_sky_mask(
    js_adjustments: serde_json::Value,
    path: String,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Value, String> {
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Sky,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let ai_source = loaded_source_id(&state);
    let params = mask_command_result(
        generate_sky_mask(
            &state.ai_state,
            &models,
            &ai_cache_key(&path, &js_adjustments),
            &warped_image,
            transform,
            ai_source.clone(),
        )
        .and_then(to_json),
        transform,
        ai_source,
    )?;
    check_cancelled(&guard)?;
    Ok(params)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_text_mask(
    js_adjustments: serde_json::Value,
    path: String,
    prompt: String,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Value, String> {
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Text,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let ai_source = loaded_source_id(&state);
    let params = mask_command_result(
        generate_text_mask(
            &state.ai_state,
            &models,
            &ai_cache_key(&path, &js_adjustments),
            &warped_image,
            &prompt,
            transform,
            ai_source.clone(),
        )
        .and_then(to_json),
        transform,
        ai_source,
    )?;
    check_cancelled(&guard)?;
    Ok(params)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_face_mask(
    js_adjustments: serde_json::Value,
    path: String,
    parts: Vec<String>,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Value, String> {
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Face,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let ai_source = loaded_source_id(&state);
    let params = mask_command_result(
        generate_face_mask(
            &state.ai_state,
            &models,
            &ai_cache_key(&path, &js_adjustments),
            &warped_image,
            &parts,
            transform,
            ai_source.clone(),
        )
        .and_then(to_json),
        transform,
        ai_source,
    )?;
    check_cancelled(&guard)?;
    Ok(params)
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
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiDepthMaskParameters, String> {
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Depth,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let params = AiDepthMaskParameters {
        min_depth,
        max_depth,
        min_fade,
        max_fade,
        feather,
        ..Default::default()
    };
    let params = generate_depth_mask(
        &state.ai_state,
        &models,
        &ai_cache_key(&path, &js_adjustments),
        &warped_image,
        params,
        transform,
        loaded_source_id(&state),
    )?;
    check_cancelled(&guard)?;
    Ok(params)
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
    skip_refinement: Option<bool>,
    task_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AiSubjectMaskParameters, String> {
    let guard = task_id.map(|id| AiTaskGuard::new(&state.active_ai_tasks, id));
    check_cancelled(&guard)?;

    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Subject,
    )
    .await
    .map_err(|e| e.to_string())?;
    check_cancelled(&guard)?;

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    check_cancelled(&guard)?;

    let transform = MaskTransform {
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
    };
    let params = generate_subject_mask(
        &state.ai_state,
        &models,
        &ai_cache_key(&path, &js_adjustments),
        &warped_image,
        start_point,
        end_point,
        skip_refinement.unwrap_or(false),
        transform,
        loaded_source_id(&state),
    )?;
    check_cancelled(&guard)?;
    Ok(params)
}

#[tauri::command]
pub async fn precompute_ai_subject_mask(
    js_adjustments: serde_json::Value,
    path: String,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let models = get_or_init_ai_models(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
        AiMaskModel::Subject,
    )
    .await
    .map_err(|e| e.to_string())?;

    let cache_key = ai_cache_key(&path, &js_adjustments);
    let is_cached = state
        .ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|s| s.embeddings.as_ref())
        .is_some_and(|cached| cached.path_hash == cache_key);
    if is_cached {
        return Ok(());
    }

    let warped_image = get_cached_full_warped_image(&state, &js_adjustments)?;
    cached_image_embeddings(&state.ai_state, &models, &cache_key, &warped_image)?;
    Ok(())
}

pub async fn generate_effect_map(
    app_handle: &tauri::AppHandle,
    kind: EffectMapKind,
    source_image: &DynamicImage,
    source_id: &str,
) -> Result<String, String> {
    let state = tauri::Manager::state::<AppState>(app_handle);
    let map = match kind {
        EffectMapKind::Depth => {
            let models = get_or_init_ai_models(
                app_handle,
                &state.ai_state,
                &state.ai_init_lock,
                AiMaskModel::Depth,
            )
            .await
            .map_err(|e| e.to_string())?;
            let session = models.depth_anything().map_err(|e| e.to_string())?;
            DynamicImage::ImageLuma8(
                run_depth_anything_model(source_image, &session).map_err(|e| e.to_string())?,
            )
        }
        EffectMapKind::Normal => {
            let session = crate::ai_processing::get_or_init_normal_model(
                app_handle,
                &state.ai_state,
                &state.ai_init_lock,
            )
            .await
            .map_err(|e| e.to_string())?;
            DynamicImage::ImageRgba8(
                crate::ai_processing::run_normal_model(source_image, &session)
                    .map_err(|e| e.to_string())?,
            )
        }
    };

    crate::effect_maps::store_source_map(kind, source_id, &map)
}

async fn generate_loaded_effect_map(
    kind: EffectMapKind,
    js_adjustments: serde_json::Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let loaded_image = get_loaded_image(&state)?;
    let source_id = crate::ai_jobs::source_id_for(&loaded_image.path)
        .ok_or("Unable to identify the loaded image")?;
    let source_image = crate::mask_generation::build_converted_source_image(
        &loaded_image.image,
        loaded_image.is_raw,
        &js_adjustments,
    );
    generate_effect_map(&app_handle, kind, &source_image, &source_id).await
}

#[tauri::command]
pub async fn generate_full_image_depth_map(
    js_adjustments: serde_json::Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    generate_loaded_effect_map(EffectMapKind::Depth, js_adjustments, state, app_handle).await
}

#[tauri::command]
pub async fn generate_relight_normal_map(
    js_adjustments: serde_json::Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    generate_loaded_effect_map(EffectMapKind::Normal, js_adjustments, state, app_handle).await
}

fn get_loaded_image(state: &tauri::State<'_, AppState>) -> Result<crate::LoadedImage, String> {
    state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "No original image loaded".to_string())
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

impl AiGenerationCapabilities {
    /// Whether the named profile (or the connector default) needs a text prompt.
    /// `None` when the connector does not advertise that profile.
    pub fn requires_prompt(&self, profile: Option<&str>) -> Option<bool> {
        let id = profile.unwrap_or(&self.default_profile);
        self.profiles
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.requires_prompt)
    }
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
    fn prompt_requirement_follows_the_advertised_profile() {
        let value = json!({"protocol_version":2,"generation":{"seed":true,"default_profile":"edit",
            "profiles":[
                {"id":"edit","label":"Edit","default_megapixels":1,"megapixels":[1]},
                {"id":"qwen21-remove-v2","label":"Remove 2","default_megapixels":1,"megapixels":[1],"requires_prompt":false}]}});
        let capabilities = parse_generation_capabilities(value).unwrap().unwrap();
        assert_eq!(capabilities.requires_prompt(None), Some(true));
        assert_eq!(
            capabilities.requires_prompt(Some("qwen21-remove-v2")),
            Some(false)
        );
        assert_eq!(capabilities.requires_prompt(Some("unknown")), None);
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
