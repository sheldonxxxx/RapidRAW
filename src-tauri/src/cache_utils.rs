use crate::AppState;
use image::DynamicImage;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

pub const GEOMETRY_KEYS: &[&str] = &[
    "transformDistortion",
    "transformVertical",
    "transformHorizontal",
    "transformRotate",
    "transformAspect",
    "transformScale",
    "transformXOffset",
    "transformYOffset",
    "lensDistortionAmount",
    "lensVignetteAmount",
    "lensTcaAmount",
    "lensDistortionParams",
    "lensMaker",
    "lensModel",
    "lensDistortionEnabled",
    "lensTcaEnabled",
    "lensVignetteEnabled",
    "guidedPerspective",
];

pub fn calculate_geometry_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    if let Some(patches) = adjustments.get("aiPatches") {
        patches.to_string().hash(&mut hasher);
    }

    for key in GEOMETRY_KEYS {
        if let Some(val) = adjustments.get(key) {
            key.hash(&mut hasher);
            val.to_string().hash(&mut hasher);
        }
    }

    hasher.finish()
}

pub fn calculate_patched_warped_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    calculate_geometry_hash(adjustments).hash(&mut hasher);

    let effects_visible = adjustments
        .get("sectionVisibility")
        .and_then(|v| v.get("effects"))
        .and_then(|s| s.as_bool())
        .unwrap_or(true);

    let blur_enabled = effects_visible && adjustments["lensBlurEnabled"].as_bool().unwrap_or(false);
    blur_enabled.hash(&mut hasher);

    if blur_enabled {
        let blur_keys = [
            "lensBlurAmount",
            "lensBlurDiffusion",
            "lensBlurShape",
            "lensBlurMinDepth",
            "lensBlurMaxDepth",
            "lensBlurMinFade",
            "lensBlurMaxFade",
            "lensBlurDepthMap",
        ];

        for key in blur_keys {
            if let Some(val) = adjustments.get(key) {
                key.hash(&mut hasher);
                val.to_string().hash(&mut hasher);
            }
        }
    }

    hasher.finish()
}

pub fn calculate_thumbnail_base_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    calculate_patched_warped_hash(adjustments).hash(&mut hasher);

    adjustments["orientationSteps"]
        .as_u64()
        .unwrap_or(0)
        .hash(&mut hasher);

    hasher.finish()
}

pub fn calculate_visual_hash(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);

    if let Some(obj) = adjustments.as_object() {
        for (key, value) in obj {
            if GEOMETRY_KEYS.contains(&key.as_str()) {
                continue;
            }

            match key.as_str() {
                "crop" | "rotation" | "orientationSteps" | "flipHorizontal" | "flipVertical" => (),
                _ => {
                    key.hash(&mut hasher);
                    value.to_string().hash(&mut hasher);
                }
            }
        }
    }

    hasher.finish()
}

pub fn calculate_transform_hash(adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();

    let orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0);
    orientation_steps.hash(&mut hasher);

    let rotation = adjustments["rotation"].as_f64().unwrap_or(0.0);
    (rotation.to_bits()).hash(&mut hasher);

    let flip_h = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
    flip_h.hash(&mut hasher);

    let flip_v = adjustments["flipVertical"].as_bool().unwrap_or(false);
    flip_v.hash(&mut hasher);

    // Share the complete patch/blur/warp fingerprint with the upstream cache.
    // Equal-length encoded maps or patch replacements can contain different pixels.
    calculate_patched_warped_hash(adjustments).hash(&mut hasher);
    if let Some(crop) = adjustments.get("crop") {
        crop.to_string().hash(&mut hasher);
    }

    hasher.finish()
}

pub fn calculate_full_job_hash(path: &str, adjustments: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    adjustments.to_string().hash(&mut hasher);
    hasher.finish()
}

/// LRU storage bounded by retained pixel bytes as well as entry count.
pub struct MaskBitmapCache<K> {
    entries: std::collections::VecDeque<(K, Arc<image::GrayImage>)>,
    bytes: usize,
    max_bytes: usize,
}

impl<K: PartialEq> MaskBitmapCache<K> {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            entries: Default::default(),
            bytes: 0,
            max_bytes,
        }
    }

    pub fn get(&mut self, key: &K) -> Option<Arc<image::GrayImage>> {
        let index = self.entries.iter().position(|(k, _)| k == key)?;
        let entry = self.entries.remove(index)?;
        let image = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(image)
    }

    pub fn insert(&mut self, key: K, image: Arc<image::GrayImage>) {
        if let Some(index) = self.entries.iter().position(|(k, _)| k == &key) {
            let (_, old) = self.entries.remove(index).unwrap();
            self.bytes -= old.as_raw().len();
        }
        let bytes = image.as_raw().len();
        if bytes > self.max_bytes {
            return;
        }
        while self.entries.len() >= 32 || self.bytes + bytes > self.max_bytes {
            let Some((_, old)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.as_raw().len();
        }
        self.bytes += bytes;
        self.entries.push_back((key, image));
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
}

pub struct DecodedImageCache {
    capacity: usize,
    items: Vec<(String, Arc<DynamicImage>, HashMap<String, String>)>,
}

impl DecodedImageCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            items: Vec::with_capacity(capacity),
        }
    }

    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity;
        while self.items.len() > self.capacity {
            self.items.remove(0);
        }
    }

    pub fn get(&mut self, path: &str) -> Option<(Arc<DynamicImage>, HashMap<String, String>)> {
        if let Some(pos) = self.items.iter().position(|(p, _, _)| p == path) {
            let item = self.items.remove(pos);
            let result = (item.1.clone(), item.2.clone());
            self.items.push(item);
            Some(result)
        } else {
            None
        }
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn insert(
        &mut self,
        path: String,
        image: Arc<DynamicImage>,
        exif: HashMap<String, String>,
    ) {
        if let Some(pos) = self.items.iter().position(|(p, _, _)| *p == path) {
            self.items.remove(pos);
        } else if self.items.len() >= self.capacity {
            self.items.remove(0);
        }
        self.items.push((path, image, exif));
    }
}

#[tauri::command]
pub fn clear_image_caches(state: tauri::State<AppState>) {
    if let Ok(mut decoded_cache) = state.decoded_image_cache.lock() {
        decoded_cache.clear();
    }
    if let Ok(mut gpu_cache) = state.gpu_image_cache.lock() {
        *gpu_cache = None;
    }
    if let Ok(mut preview_cache) = state.cached_preview.lock() {
        *preview_cache = None;
    }
    if let Ok(mut warped_cache) = state.full_warped_cache.lock() {
        *warped_cache = None;
    }
    if let Ok(mut patched_warped_cache) = state.patched_warped_cache.lock() {
        *patched_warped_cache = None;
    }
    if let Ok(mut transformed_cache) = state.full_transformed_cache.lock() {
        *transformed_cache = None;
    }
}

#[tauri::command]
pub fn clear_session_caches(state: tauri::State<AppState>) {
    crate::mask_generation::clear_component_mask_cache();
    if let Ok(mut patch_cache) = state.patch_cache.lock() {
        patch_cache.clear();
    }
    if let Ok(mut mask_cache) = state.mask_cache.lock() {
        mask_cache.clear();
    }
    if let Ok(mut geometry_cache) = state.geometry_cache.lock() {
        geometry_cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mask_cache_bounds_bytes_updates_duplicates_and_keeps_recent_entries() {
        let mut cache = MaskBitmapCache::new(8);
        let image = || Arc::new(image::GrayImage::new(2, 2));
        cache.insert(1, image());
        cache.insert(2, image());
        assert!(cache.get(&1).is_some());
        cache.insert(3, image());
        assert!(cache.get(&2).is_none());
        assert!(cache.get(&1).is_some());
        cache.insert(3, image());
        assert_eq!(cache.bytes, 8);
        assert_eq!(cache.entries.len(), 2);
        cache.insert(4, Arc::new(image::GrayImage::new(3, 3)));
        assert!(cache.get(&4).is_none());
        assert_eq!(cache.bytes, 8);
        cache.clear();
        assert_eq!(cache.bytes, 0);
        assert!(cache.get(&1).is_none());
    }

    #[test]
    fn transform_keys_follow_content_but_ignore_tonal_edits() {
        let base = json!({"lensBlurEnabled":true,"lensBlurDepthMap":"AAAA",
            "aiPatches":[{"id":"p","patchData":{"color":"AAAA","mask":"BBBB"}}]});
        let original = calculate_transform_hash(&base);
        for (key, value) in [
            ("lensBlurDepthMap", json!("CCCC")),
            ("crop", json!({"x":2})),
            ("rotation", json!(5)),
            ("flipHorizontal", json!(true)),
            ("transformScale", json!(1.5)),
        ] {
            let mut changed = base.clone();
            changed[key] = value;
            assert_ne!(original, calculate_transform_hash(&changed), "{key}");
        }
        let mut changed = base.clone();
        changed["aiPatches"][0]["patchData"]["color"] = json!("CCCC");
        assert_ne!(original, calculate_transform_hash(&changed));
        changed = base.clone();
        changed["aiPatches"][0]["opacity"] = json!(40);
        assert_ne!(original, calculate_transform_hash(&changed));
        changed = base;
        changed["exposure"] = json!(1.5);
        assert_eq!(original, calculate_transform_hash(&changed));
    }

    #[test]
    fn subject_image_cache_changes_with_retouch_pixels() {
        let base = json!({
            "transformScale": 1.0,
            "aiPatches": [{"visible": true, "patchData": {"color": "AAAA", "mask": "BBBB"}}]
        });
        let original = calculate_geometry_hash(&base);
        let mut changed = base.clone();
        changed["aiPatches"][0]["patchData"]["color"] = json!("CCCC");
        assert_ne!(original, calculate_geometry_hash(&changed));
        changed = base.clone();
        changed["aiPatches"][0]["visible"] = json!(false);
        assert_ne!(original, calculate_geometry_hash(&changed));
        changed = base;
        changed["exposure"] = json!(1.0);
        assert_eq!(original, calculate_geometry_hash(&changed));
    }
}
