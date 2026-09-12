use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::file_management::parse_virtual_path;
use base64::{Engine as _, engine::general_purpose};
use image::ImageFormat;
use image::{DynamicImage, GenericImageView, GrayImage, Rgb32FImage};
use nalgebra::Matrix3;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

use crate::formats::is_raw_file;
use crate::image_processing::apply_cpu_default_raw_processing;
use crate::panorama_utils::{processing, stitching};

pub const BRIEF_DESCRIPTOR_SIZE: usize = 256;
pub type Descriptor = [u8; BRIEF_DESCRIPTOR_SIZE / 8];

#[derive(Debug, Clone, Copy)]
pub struct KeyPoint {
    pub x: u32,
    pub y: u32,
}

pub struct Feature {
    pub keypoint: KeyPoint,
    pub descriptor: Descriptor,
}

#[derive(Debug, Clone, Copy)]
pub struct Match {
    pub index1: usize,
    pub index2: usize,
}

pub struct ImageInfo {
    pub id: usize,
    pub filename: String,
    pub image: Rgb32FImage,
    pub low_detail_mask: GrayImage,
    pub scale_factor: f64,
    pub features: Vec<Feature>,
}

#[derive(Clone)]
pub struct MatchInfo {
    pub homography: Matrix3<f64>,
    pub inliers: usize,
}

#[tauri::command]
pub async fn stitch_panorama(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if paths.len() < 2 {
        return Err("Please select at least two images to stitch.".to_string());
    }

    let source_paths: Vec<String> = paths
        .iter()
        .map(|p| parse_virtual_path(p).0.to_string_lossy().into_owned())
        .collect();

    let panorama_result_handle = state.panorama_result.clone();

    let task = tokio::task::spawn_blocking(move || {
        let panorama_result = stitch_images(source_paths, app_handle.clone());

        match panorama_result {
            Ok(panorama_image) => {
                let _ = app_handle.emit("panorama-progress", "Creating preview...");

                let (w, h) = panorama_image.dimensions();
                let (new_w, new_h) = if w > h {
                    (800, (800.0 * h as f32 / w as f32).round() as u32)
                } else {
                    ((800.0 * w as f32 / h as f32).round() as u32, 800)
                };

                let preview_f32 =
                    crate::image_processing::downscale_f32_image(&panorama_image, new_w, new_h);

                let preview_u8 = preview_f32.to_rgb8();

                let mut buf = Cursor::new(Vec::new());

                if let Err(e) = preview_u8.write_to(&mut buf, ImageFormat::Png) {
                    return Err(format!("Failed to encode panorama preview: {}", e));
                }

                let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
                let final_base64 = format!("data:image/png;base64,{}", base64_str);

                *panorama_result_handle.lock().unwrap() = Some(panorama_image);

                let _ = app_handle.emit(
                    "panorama-complete",
                    serde_json::json!({
                        "base64": final_base64,
                    }),
                );
                Ok(())
            }
            Err(e) => {
                let _ = app_handle.emit("panorama-error", e.clone());
                Err(e)
            }
        }
    });

    match task.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(join_err) => Err(format!("Panorama task failed: {}", join_err)),
    }
}

#[tauri::command]
pub async fn save_panorama(
    first_path_str: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let panorama_image = state
        .panorama_result
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| {
            "No panorama image found in memory to save. It might have already been saved."
                .to_string()
        })?;

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("panorama");

    let (output_filename, image_to_save): (String, DynamicImage) =
        if panorama_image.color().has_alpha() {
            (
                format!("{}_Pano.png", stem),
                DynamicImage::ImageRgba8(panorama_image.to_rgba8()),
            )
        } else if panorama_image.as_rgb32f().is_some() {
            (format!("{}_Pano.tiff", stem), panorama_image)
        } else {
            (
                format!("{}_Pano.png", stem),
                DynamicImage::ImageRgb8(panorama_image.to_rgb8()),
            )
        };

    let output_path = parent_dir.join(output_filename);

    image_to_save
        .save(&output_path)
        .map_err(|e| format!("Failed to save panorama image: {}", e))?;

    let (real_path, _) = crate::file_management::parse_virtual_path(&first_path_str);
    let _ =
        crate::exif_processing::write_rrexif_sidecar(&real_path.to_string_lossy(), &output_path);

    Ok(output_path.to_string_lossy().to_string())
}

fn stitch_images(image_paths: Vec<String>, app_handle: AppHandle) -> Result<DynamicImage, String> {
    stitch_images_inner(image_paths, app_handle, false)
}

/// MCP provenance promises contribution from every supplied source. The desktop
/// entrypoint retains its existing partial-panorama warning behavior.
#[cfg(feature = "mcp")]
pub(crate) fn stitch_panorama_for_mcp(
    image_paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<DynamicImage, String> {
    stitch_images_inner(image_paths, app_handle, true)
}

fn stitch_images_inner(
    image_paths: Vec<String>,
    app_handle: AppHandle,
    require_all_inputs: bool,
) -> Result<DynamicImage, String> {
    if image_paths.len() < 2 {
        return Err("At least two images are required for a panorama.".to_string());
    }

    let _ = app_handle.emit("panorama-progress", "Starting panorama process...");
    println!(
        "Starting panorama stitching process for {} images...",
        image_paths.len()
    );

    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Loading and preparing images...");
    println!("Loading and preparing images (in parallel)...");
    let brief_pairs = processing::generate_brief_pairs();

    let image_data_results: Vec<Result<(ImageInfo, GrayImage), String>> = image_paths
        .par_iter()
        .enumerate()
        .map(|(i, filename)| {
            let _ = app_handle.emit(
                "panorama-progress",
                format!(
                    "Processing '{}'",
                    Path::new(filename)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ),
            );
            println!("  - Processing '{}'", filename);

            let file_bytes = fs::read(filename)
                .map_err(|e| format!("Failed to read image {}: {}", filename, e))?;

            let mut dynamic_image = crate::image_loader::load_base_image_from_bytes(
                &file_bytes,
                filename,
                false,
                &settings,
                None,
            )
            .map_err(|e| format!("Failed to load image {}: {}", filename, e))?;

            if is_raw_file(filename) {
                apply_cpu_default_raw_processing(&mut dynamic_image);
            }

            let image_f32 = dynamic_image.to_rgb32f();

            let color_full_u8 = dynamic_image.to_rgb8();
            let gray_full = image::imageops::colorops::grayscale(&color_full_u8);

            let (w, h) = gray_full.dimensions();
            let (new_w, new_h, scale_factor) = processing::calculate_downscale_dimensions(w, h);

            let gray_small = image::imageops::resize(
                &gray_full,
                new_w,
                new_h,
                image::imageops::FilterType::Triangle,
            );

            let low_detail_mask = processing::generate_low_detail_mask(&gray_full);

            let features = processing::find_features(&gray_small, &brief_pairs);
            println!("    Found {} features in '{}'", features.len(), filename);

            Ok((
                ImageInfo {
                    id: i,
                    filename: filename.to_string(),
                    image: image_f32,
                    low_detail_mask,
                    scale_factor,
                    features,
                },
                gray_small,
            ))
        })
        .collect();

    let mut image_data = Vec::new();
    let mut detection_proxies = Vec::new();
    for result in image_data_results {
        let (info, gray) = result?;
        image_data.push(info);
        detection_proxies.push(gray);
    }

    println!(
        "Image loading and feature detection completed in {:.2?}\n",
        start_time.elapsed()
    );

    let start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Finding image matches...");
    println!("Finding all pairwise matches (in parallel)...");
    let mut pairwise_matches = find_pairwise_matches(&image_data);
    if !match_graph_connected(image_data.len(), &pairwise_matches) {
        let _ = app_handle.emit(
            "panorama-progress",
            "Retrying low-contrast feature detection...",
        );
        println!(
            "Retrying disconnected match graph with normalized detection proxies (same resolution)..."
        );
        image_data
            .par_iter_mut()
            .zip(detection_proxies.par_iter())
            .for_each(|(info, gray)| {
                info.features = processing::find_features_low_contrast(gray, &brief_pairs);
                println!(
                    "    Fallback found {} features in '{}'",
                    info.features.len(),
                    info.filename
                );
            });
        for (pair, matched) in find_pairwise_matches(&image_data) {
            // Preserve already accepted geometry; only connect missing edges.
            pairwise_matches.entry(pair).or_insert(matched);
        }
    }
    drop(detection_proxies);
    require_connected_inputs(image_data.len(), &pairwise_matches, require_all_inputs)?;
    println!(
        "Pairwise matching completed in {:.2?}\n",
        start_time.elapsed()
    );

    if pairwise_matches.is_empty() {
        return Err(
            "No suitable matches found between any pair of images. Cannot create a panorama."
                .to_string(),
        );
    }

    let start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Determining stitching order...");
    println!("Determining stitching order...");
    let (ordered_indices, global_homographies) =
        build_stitching_order(&image_data, &pairwise_matches);

    if ordered_indices.len() < 2 {
        return Err("Could not find a connected sequence of at least two images.".to_string());
    }

    let ordered_filenames: Vec<_> = ordered_indices
        .iter()
        .map(|&i| {
            Path::new(&image_data[i].filename)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        })
        .collect();
    println!("Stitching order determined: {:?}", ordered_filenames);
    let _ = app_handle.emit(
        "panorama-progress",
        format!("Stitching order: {}", ordered_filenames.join(" -> ")),
    );

    let stitched_images_info: Vec<&ImageInfo> =
        ordered_indices.iter().map(|&i| &image_data[i]).collect();
    let mut bounds = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for image in &stitched_images_info {
        let projected =
            validate_projected_domain(image.image.dimensions(), &global_homographies[&image.id])?;
        bounds.0 = bounds.0.min(projected.0);
        bounds.1 = bounds.1.max(projected.1);
        bounds.2 = bounds.2.min(projected.2);
        bounds.3 = bounds.3.max(projected.3);
    }
    if require_all_inputs {
        validate_mcp_canvas_budget(bounds)?;
    }
    let unstitched_count = image_data.len() - stitched_images_info.len();
    if unstitched_count > 0 {
        let warning_msg = format!(
            "Warning: {} image(s) could not be matched and will be excluded.",
            unstitched_count
        );
        println!("{}", warning_msg);
        let _ = app_handle.emit("panorama-warning", warning_msg);
    }
    println!(
        "Global homography calculation completed in {:.2?}\n",
        start_time.elapsed()
    );

    let start_time = Instant::now();
    let _ = app_handle.emit("panorama-progress", "Warping and blending images...");
    println!("Warping and blending full-resolution images with progressive optimal seams...");

    let panorama = stitching::progressive_seam_stitcher(
        &stitched_images_info,
        &global_homographies,
        app_handle.clone(),
    );

    println!("Stitching completed in {:.2?}\n", start_time.elapsed());

    let _ = app_handle.emit("panorama-progress", "Finalizing panorama...");

    Ok(DynamicImage::ImageRgb32F(panorama))
}

fn find_pairwise_matches(image_data: &[ImageInfo]) -> HashMap<(usize, usize), MatchInfo> {
    let mut pairwise_matches: HashMap<(usize, usize), MatchInfo> = HashMap::new();

    let pairs_to_check: Vec<(usize, usize)> = (0..image_data.len())
        .flat_map(|i| (i + 1..image_data.len()).map(move |j| (i, j)))
        .collect();

    let match_results: Vec<Option<((usize, usize), MatchInfo)>> = pairs_to_check
        .par_iter()
        .map(|&(i, j)| {
            let features1 = &image_data[i].features;
            let features2 = &image_data[j].features;

            let initial_matches = processing::match_features(features1, features2);
            if initial_matches.len() < processing::MIN_INLIERS_FOR_CONNECTION {
                return None;
            }

            let keypoints1: Vec<KeyPoint> = features1.iter().map(|f| f.keypoint).collect();
            let keypoints2: Vec<KeyPoint> = features2.iter().map(|f| f.keypoint).collect();

            if let Some((_h_small, inliers)) =
                processing::find_homography_ransac(&initial_matches, &keypoints1, &keypoints2)
                && inliers.len() >= processing::MIN_INLIERS_FOR_CONNECTION
            {
                println!(
                    "  - Good match found: '{}' <-> '{}' ({} inliers)",
                    Path::new(&image_data[i].filename)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy(),
                    Path::new(&image_data[j].filename)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy(),
                    inliers.len()
                );

                let inlier_points: Vec<(nalgebra::Point2<f64>, nalgebra::Point2<f64>)> = inliers
                    .iter()
                    .map(|m| {
                        let p1 = keypoints1[m.index1];
                        let p2 = keypoints2[m.index2];
                        (
                            nalgebra::Point2::new(p1.x as f64, p1.y as f64),
                            nalgebra::Point2::new(p2.x as f64, p2.y as f64),
                        )
                    })
                    .collect();

                if let Some(h_refined) = processing::compute_homography(&inlier_points) {
                    let s1 = image_data[i].scale_factor;
                    let s2 = image_data[j].scale_factor;
                    let scale_mat_i_inv =
                        Matrix3::new(1.0 / s1, 0.0, 0.0, 0.0, 1.0 / s1, 0.0, 0.0, 0.0, 1.0);
                    let scale_mat_j = Matrix3::new(s2, 0.0, 0.0, 0.0, s2, 0.0, 0.0, 0.0, 1.0);
                    let h_full = scale_mat_j * h_refined * scale_mat_i_inv;
                    // Tree construction and blending both invert accepted edges.
                    if !homography_finite_and_invertible(&h_full) {
                        return None;
                    }

                    let scale = h_full
                        .iter()
                        .map(|value| value.abs())
                        .fold(0.0_f64, f64::max);
                    let match_info = MatchInfo {
                        homography: h_full / scale,
                        inliers: inliers.len(),
                    };
                    return Some(((i, j), match_info));
                }
            }
            None
        })
        .collect();

    for result in match_results.into_iter().flatten() {
        pairwise_matches.insert(result.0, result.1);
    }
    pairwise_matches
}

fn match_graph_connected(count: usize, matches: &HashMap<(usize, usize), MatchInfo>) -> bool {
    if count == 0 {
        return false;
    }
    let mut visited = HashSet::from([0]);
    let mut pending = VecDeque::from([0]);
    while let Some(current) = pending.pop_front() {
        for &(first, second) in matches.keys() {
            let next = if first == current {
                second
            } else if second == current {
                first
            } else {
                continue;
            };
            if next < count && visited.insert(next) {
                pending.push_back(next);
            }
        }
    }
    visited.len() == count
}

fn require_connected_inputs(
    count: usize,
    matches: &HashMap<(usize, usize), MatchInfo>,
    required: bool,
) -> Result<(), String> {
    if required && !match_graph_connected(count, matches) {
        return Err("PANORAMA_DISCONNECTED: MCP panorama requires all input images to be connected by reliable matches; no partial result was produced.".into());
    }
    Ok(())
}

fn homography_finite_and_invertible(h: &Matrix3<f64>) -> bool {
    if !h.iter().all(|value| value.is_finite()) {
        return false;
    }
    let scale = h.iter().map(|value| value.abs()).fold(0.0_f64, f64::max);
    scale > 0.0
        && (h / scale)
            .try_inverse()
            .is_some_and(|inverse| inverse.iter().all(|value| value.is_finite()))
}

fn validate_projected_domain(
    dimensions: (u32, u32),
    h: &Matrix3<f64>,
) -> Result<(f64, f64, f64, f64), String> {
    let invalid = || {
        "PANORAMA_INVALID_PROJECTION: A source crosses or approaches the reference plane, or has a non-finite/singular transform. Use a smaller overlapping capture group; no panorama was produced.".to_string()
    };
    if !homography_finite_and_invertible(h) {
        return Err(invalid());
    }
    let scale = h.iter().map(|value| value.abs()).fold(0.0_f64, f64::max);
    let normalized = h / scale;
    let (width, height) = (dimensions.0 as f64, dimensions.1 as f64);
    let projected = [(0.0, 0.0), (width, 0.0), (width, height), (0.0, height)]
        .map(|(x, y)| normalized * nalgebra::Vector3::new(x, y, 1.0));
    let denominator_scale = projected
        .iter()
        .map(|point| point.z.abs())
        .fold(0.0_f64, f64::max);
    if !denominator_scale.is_finite() || denominator_scale == 0.0 {
        return Err(invalid());
    }
    let sign = projected[0].z.is_sign_positive();
    // The denominator is affine over the image. Equal nonzero corner signs
    // establish that the interior cannot cross the projective reference plane.
    // Compare relative magnitudes so multiplying H by any uniform sign/scale
    // does not change validity.
    let mut bounds = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for point in projected {
        if !point.iter().all(|value| value.is_finite())
            || point.z.is_sign_positive() != sign
            || point.z.abs() / denominator_scale <= 1e-6
            || !(point.x / point.z).is_finite()
            || !(point.y / point.z).is_finite()
        {
            return Err(invalid());
        }
        let (x, y) = (point.x / point.z, point.y / point.z);
        bounds.0 = bounds.0.min(x);
        bounds.1 = bounds.1.max(x);
        bounds.2 = bounds.2.min(y);
        bounds.3 = bounds.3.max(y);
    }
    Ok(bounds)
}

fn validate_mcp_canvas_budget(bounds: (f64, f64, f64, f64)) -> Result<(), String> {
    // Match the MCP decoded-asset limit before the stitcher allocates RGB32F,
    // masks, and seam work buffers for this exact corner-derived canvas.
    let width = (bounds.1 - bounds.0).ceil();
    let height = (bounds.3 - bounds.2).ceil();
    if !width.is_finite()
        || !height.is_finite()
        || width < 1.0
        || height < 1.0
        || width * height > 100_000_000.0
    {
        return Err("PANORAMA_CANVAS_TOO_LARGE: The projected panorama exceeds the MCP 100-megapixel canvas limit. Use a smaller overlapping capture group; no panorama was allocated.".into());
    }
    Ok(())
}

struct Dsu {
    parent: Vec<usize>,
}

impl Dsu {
    fn new(n: usize) -> Self {
        Dsu {
            parent: (0..n).collect(),
        }
    }

    fn find(&mut self, i: usize) -> usize {
        if self.parent[i] == i {
            i
        } else {
            self.parent[i] = self.find(self.parent[i]);
            self.parent[i]
        }
    }

    fn union(&mut self, i: usize, j: usize) {
        let root_i = self.find(i);
        let root_j = self.find(j);
        if root_i != root_j {
            self.parent[root_i] = root_j;
        }
    }
}

fn build_stitching_order(
    images: &[ImageInfo],
    matches: &HashMap<(usize, usize), MatchInfo>,
) -> (Vec<usize>, HashMap<usize, Matrix3<f64>>) {
    if images.is_empty() {
        return (vec![], HashMap::new());
    }
    let n = images.len();
    if n < 2 {
        let mut homographies = HashMap::new();
        if n == 1 {
            homographies.insert(0, Matrix3::identity());
        }
        return ((0..n).collect(), homographies);
    }

    let mut edges = Vec::new();
    for (&(i, j), m) in matches {
        edges.push((m.inliers, i, j));
    }
    edges.sort_by_key(|&(inliers, first, second)| (std::cmp::Reverse(inliers), first, second));

    let mut mst_adj: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut dsu = Dsu::new(n);
    let mut num_edges = 0;

    for &(_, i, j) in &edges {
        if dsu.find(i) != dsu.find(j) {
            dsu.union(i, j);
            mst_adj.entry(i).or_default().push(j);
            mst_adj.entry(j).or_default().push(i);
            num_edges += 1;
            if num_edges == n - 1 {
                break;
            }
        }
    }

    // A leaf reference can place distant frames beyond the reference plane in
    // a wide panorama. A tree center minimizes accumulated view rotations.
    let start_node = (0..n)
        .filter(|i| mst_adj.contains_key(i))
        .min_by_key(|&candidate| {
            let mut distances = HashMap::from([(candidate, 0usize)]);
            let mut pending = VecDeque::from([candidate]);
            while let Some(current) = pending.pop_front() {
                for &next in &mst_adj[&current] {
                    if !distances.contains_key(&next) {
                        distances.insert(next, distances[&current] + 1);
                        pending.push_back(next);
                    }
                }
            }
            (
                std::cmp::Reverse(distances.len()),
                distances.values().copied().max().unwrap_or(0),
                distances.values().sum::<usize>(),
                candidate,
            )
        })
        .unwrap_or(0);

    let mut ordered_indices = Vec::new();
    let mut global_homographies = HashMap::new();
    let mut q = VecDeque::new();
    let mut visited = HashSet::new();

    q.push_back((start_node, Matrix3::identity()));
    visited.insert(start_node);

    while let Some((u, h_u_global)) = q.pop_front() {
        ordered_indices.push(u);
        global_homographies.insert(u, h_u_global);

        if let Some(neighbors) = mst_adj.get(&u) {
            for &v in neighbors {
                if !visited.contains(&v) {
                    visited.insert(v);

                    let h_vu = if let Some(m) = matches.get(&(v, u)) {
                        m.homography
                    } else if let Some(m) = matches.get(&(u, v)) {
                        m.homography
                            .try_inverse()
                            .expect("Failed to invert homography for MST edge")
                    } else {
                        panic!("Match not found for MST edge between {} and {}", u, v);
                    };

                    let h_v_global = h_u_global * h_vu;
                    q.push_back((v, h_v_global));
                }
            }
        }
    }

    (ordered_indices, global_homographies)
}

#[cfg(test)]
mod panorama_fallback_tests {
    use super::*;
    use image::Luma;

    fn scene(width: u32, seed: u64, high_contrast: bool) -> GrayImage {
        GrayImage::from_fn(width, 320, |x, y| {
            let mut value = (x as u64 / 7)
                .wrapping_mul(0x9e3779b97f4a7c15)
                .wrapping_add((y as u64 / 11).wrapping_mul(0xbf58476d1ce4e5b9))
                .wrapping_add(seed);
            value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
            let level = ((value ^ (value >> 31)) % 13) as u8;
            Luma([if high_contrast {
                12 + level * 19
            } else {
                120 + level
            }])
        })
    }

    fn info(id: usize, gray: &GrayImage, fallback: bool) -> ImageInfo {
        let pairs = processing::generate_brief_pairs();
        ImageInfo {
            id,
            filename: format!("generated-fixture-{id}.png"),
            image: DynamicImage::ImageLuma8(gray.clone()).to_rgb32f(),
            low_detail_mask: GrayImage::new(gray.width(), gray.height()),
            scale_factor: 1.0,
            features: if fallback {
                processing::find_features_low_contrast(gray, &pairs)
            } else {
                processing::find_features(gray, &pairs)
            },
        }
    }

    fn overlapping(high_contrast: bool) -> [GrayImage; 2] {
        let master = scene(920, 712, high_contrast);
        [
            image::imageops::crop_imm(&master, 0, 0, 640, 320).to_image(),
            image::imageops::crop_imm(&master, 280, 0, 640, 320).to_image(),
        ]
    }

    #[test]
    fn normalized_retry_recovers_low_contrast_overlap_without_relaxing_match_acceptance() {
        let frames = overlapping(false);
        let original = [info(0, &frames[0], false), info(1, &frames[1], false)];
        assert!(original.iter().all(|image| image.features.is_empty()));
        assert!(find_pairwise_matches(&original).is_empty());
        let retried = [info(0, &frames[0], true), info(1, &frames[1], true)];
        let matches = find_pairwise_matches(&retried);
        require_connected_inputs(retried.len(), &matches, true).unwrap();
        let matched = &matches[&(0, 1)];
        assert!(matched.inliers >= processing::MIN_INLIERS_FOR_CONNECTION);
        // Independent scene-construction oracle: the second image begins 280px
        // to the right of the first, with no scale, rotation or perspective.
        for (x, y) in [(320.0, 40.0), (450.0, 150.0), (600.0, 270.0)] {
            let mapped = matched.homography * nalgebra::Vector3::new(x, y, 1.0);
            assert!((mapped.x / mapped.z - (x - 280.0)).abs() < 0.1);
            assert!((mapped.y / mapped.z - y).abs() < 0.1);
        }
    }

    #[test]
    fn low_contrast_retry_does_not_make_blank_or_unrelated_images_connect() {
        let blank = GrayImage::from_pixel(640, 320, Luma([127]));
        let blank_info = info(0, &blank, true);
        assert!(blank_info.features.is_empty());
        let unrelated = [
            info(0, &scene(640, 83, false), true),
            info(1, &scene(640, 917, false), true),
        ];
        assert!(find_pairwise_matches(&unrelated).is_empty());
        let blank_pair = [blank_info, info(1, &scene(640, 83, false), true)];
        assert!(find_pairwise_matches(&blank_pair).is_empty());
    }

    #[test]
    fn strict_panorama_rejects_an_unconnected_input_while_desktop_can_keep_partial_result() {
        let frames = overlapping(false);
        let blank = GrayImage::from_pixel(640, 320, Luma([127]));
        let inputs = [
            info(0, &frames[0], true),
            info(1, &frames[1], true),
            info(2, &blank, true),
        ];
        let matches = find_pairwise_matches(&inputs);
        assert!(matches.contains_key(&(0, 1)));
        assert!(!match_graph_connected(inputs.len(), &matches));
        let error = require_connected_inputs(inputs.len(), &matches, true).unwrap_err();
        assert!(error.starts_with("PANORAMA_DISCONNECTED:"));
        assert!(error.contains("all input images"));
        require_connected_inputs(inputs.len(), &matches, false).unwrap();
        assert_eq!(build_stitching_order(&inputs, &matches).0.len(), 2);
    }

    #[test]
    fn existing_detector_still_connects_high_contrast_overlaps_without_retry() {
        let frames = overlapping(true);
        let inputs = [info(0, &frames[0], false), info(1, &frames[1], false)];
        let matches = find_pairwise_matches(&inputs);
        assert!(match_graph_connected(inputs.len(), &matches));
        require_connected_inputs(inputs.len(), &matches, true).unwrap();
    }

    #[test]
    fn centered_reference_keeps_three_rotated_views_in_front_of_projection_plane() {
        let width = 160;
        let height = 120;
        let focal = width as f64 / 2.0 / 36.5_f64.to_radians().tan();
        let k = Matrix3::new(
            focal,
            0.0,
            width as f64 / 2.0,
            0.0,
            focal,
            height as f64 / 2.0,
            0.0,
            0.0,
            1.0,
        );
        let angle = 31.5_f64.to_radians();
        let rotation = Matrix3::new(
            angle.cos(),
            0.0,
            -angle.sin(),
            0.0,
            1.0,
            0.0,
            angle.sin(),
            0.0,
            angle.cos(),
        );
        let neighbor = k * rotation * k.try_inverse().unwrap();
        let gray = GrayImage::new(width, height);
        let inputs = [
            info(0, &gray, false),
            info(1, &gray, false),
            info(2, &gray, false),
        ];
        let matches = HashMap::from([
            (
                (0, 1),
                MatchInfo {
                    homography: neighbor,
                    inliers: 100,
                },
            ),
            (
                (1, 2),
                MatchInfo {
                    homography: neighbor,
                    inliers: 90,
                },
            ),
        ]);
        let leaf_reference = neighbor.try_inverse().unwrap() * neighbor.try_inverse().unwrap();
        assert!(validate_projected_domain((width, height), &leaf_reference).is_err());
        let (ordered, transforms) = build_stitching_order(&inputs, &matches);
        assert_eq!(ordered[0], 1, "The central view must be the reference");
        assert_eq!(ordered.len(), 3);
        for h in transforms.values() {
            validate_projected_domain((width, height), h).unwrap();
        }
    }

    #[test]
    fn mcp_canvas_budget_checks_rounded_dimensions_before_allocation() {
        validate_mcp_canvas_budget((-5000.0, 5000.0, -5000.0, 5000.0)).unwrap();
        for bounds in [
            (-5000.0, 5000.001, -5000.0, 5000.0),
            (0.0, f64::INFINITY, 0.0, 100.0),
            (0.0, 0.0, 0.0, 100.0),
        ] {
            assert!(
                validate_mcp_canvas_budget(bounds)
                    .unwrap_err()
                    .contains("PANORAMA_CANVAS_TOO_LARGE")
            );
        }
    }

    #[test]
    fn projection_guard_is_scale_sign_invariant_and_rejects_poles_or_invalid_matrices() {
        let valid = Matrix3::new(1.0, 0.02, 20.0, 0.01, 1.0, -3.0, 0.0002, -0.0001, 1.0);
        for scale in [1.0, -7.0, 1e-100, -1e-100] {
            validate_projected_domain((160, 120), &(valid * scale)).unwrap();
        }
        for x_coefficient in [-2.0 / 160.0, (-1.0 + 1e-9) / 160.0] {
            let pole = Matrix3::new(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, x_coefficient, 0.0, 1.0);
            assert!(validate_projected_domain((160, 120), &pole).is_err());
        }
        for invalid in [
            Matrix3::zeros(),
            Matrix3::repeat(f64::NAN),
            Matrix3::repeat(f64::INFINITY),
            Matrix3::new(1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0),
        ] {
            assert!(!homography_finite_and_invertible(&invalid));
            assert!(validate_projected_domain((160, 120), &invalid).is_err());
        }
    }
}
