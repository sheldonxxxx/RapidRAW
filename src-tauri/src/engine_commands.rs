//! Shared native photo operations used by desktop commands and automation.
//! Transport adapters retain their own scheduling, history and file policies.

use crate::{
    app_state::AppState,
    export_processing::TiffBitDepth,
    gpu_processing::{RenderOutputPrecision, RenderRequest},
    image_loader::LoadImageResult,
    image_processing::{AllAdjustments, GpuContext},
    mask_generation::MaskDefinition,
};
use image::{DynamicImage, GenericImageView, GrayImage};
use serde::Serialize;
use serde_json::Value;
use std::borrow::Cow;

pub(crate) const CONTRACT_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CommandId {
    Open,
    Adjust,
    Mask,
    Render,
    Export,
}

#[derive(Serialize)]
pub(crate) struct CommandDescriptor {
    pub id: CommandId,
    pub desktop_commands: &'static [&'static str],
    pub mcp_methods: &'static [&'static str],
}

const COMMANDS: &[CommandDescriptor] = &[
    CommandDescriptor {
        id: CommandId::Open,
        desktop_commands: &["load_image"],
        mcp_methods: &["open_photo"],
    },
    CommandDescriptor {
        id: CommandId::Adjust,
        desktop_commands: &["apply_adjustments"],
        mcp_methods: &["set_adjustments", "load_recipe"],
    },
    CommandDescriptor {
        id: CommandId::Mask,
        desktop_commands: &["generate_mask_overlay"],
        mcp_methods: &[
            "mask_create",
            "mask_duplicate",
            "mask_update",
            "mask_remove",
        ],
    },
    CommandDescriptor {
        id: CommandId::Render,
        desktop_commands: &["apply_adjustments", "generate_comparison_preview"],
        mcp_methods: &["render"],
    },
    CommandDescriptor {
        id: CommandId::Export,
        desktop_commands: &["export_images"],
        mcp_methods: &["export"],
    },
];

#[derive(Serialize)]
pub(crate) struct CommandContract {
    pub version: u32,
    pub commands: &'static [CommandDescriptor],
}

pub(crate) fn contract() -> CommandContract {
    CommandContract {
        version: CONTRACT_VERSION,
        commands: COMMANDS,
    }
}

#[cfg(any(feature = "mcp", test))]
pub(crate) fn command_for_mcp(method: &str) -> Option<CommandId> {
    COMMANDS
        .iter()
        .find(|command| command.mcp_methods.contains(&method))
        .map(|command| command.id)
}

pub(crate) struct OpenRequest {
    pub path: String,
}

pub(crate) async fn open(
    request: OpenRequest,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<LoadImageResult, String> {
    crate::image_loader::load_image_native(request.path, state, app_handle).await
}

pub(crate) struct AdjustRequest<'a> {
    pub adjustments: &'a Value,
    pub is_raw: bool,
    pub tonemapper_override: Option<u32>,
    pub show_clipping: bool,
}

/// Resolve native values without applying a transport-specific recipe schema.
pub(crate) fn effective_adjustments(request: AdjustRequest<'_>) -> AllAdjustments {
    let mut resolved = crate::image_processing::get_all_adjustments_from_json(
        request.adjustments,
        request.is_raw,
        request.tonemapper_override,
    );
    resolved.global.show_clipping = u32::from(request.show_clipping);
    resolved
}

pub(crate) fn final_adjustments(
    adjustments: &Value,
    is_raw: bool,
    tonemapper_override: Option<u32>,
) -> AllAdjustments {
    effective_adjustments(AdjustRequest {
        adjustments,
        is_raw,
        tonemapper_override,
        show_clipping: false,
    })
}

pub(crate) struct MaskRequest<'a> {
    pub definitions: &'a [MaskDefinition],
    pub source: &'a DynamicImage,
    pub adjustments: &'a Value,
    pub is_raw: bool,
    pub dimensions: (u32, u32),
    pub scale: f32,
    pub crop_offset: (f32, f32),
}

pub(crate) fn source_masks(
    request: MaskRequest<'_>,
    check_cancelled: impl FnMut() -> Result<(), String>,
) -> Result<Vec<GrayImage>, String> {
    let bitmaps = crate::mask_generation::render_source_mask_bitmaps_checked(
        request.definitions,
        Some(request.source),
        request.is_raw,
        request.adjustments,
        request.dimensions.0,
        request.dimensions.1,
        request.scale,
        request.crop_offset,
        check_cancelled,
    )?;
    let visible_count = request
        .definitions
        .iter()
        .filter(|mask| mask.visible)
        .count();
    if bitmaps.len() != visible_count {
        return Err("Could not rasterize every visible mask".into());
    }
    Ok(bitmaps)
}

pub(crate) struct MaskRasterRequest<'a> {
    pub definition: &'a MaskDefinition,
    pub dimensions: (u32, u32),
    pub scale: f32,
    pub crop_offset: (f32, f32),
    pub warped_image: Option<&'a DynamicImage>,
}

pub(crate) fn rasterize_mask(request: MaskRasterRequest<'_>) -> Option<GrayImage> {
    crate::mask_generation::generate_mask_bitmap(
        request.definition,
        request.dimensions.0,
        request.dimensions.1,
        request.scale,
        request.crop_offset,
        request.warped_image,
    )
}

pub(crate) struct PreparedPhoto {
    pub image: DynamicImage,
    pub masks: Vec<MaskDefinition>,
    pub bitmaps: Vec<GrayImage>,
    pub crop_offset: (f32, f32),
}

/// Prepare an already composited source at native resolution. Mask evaluation
/// receives the captured source, independent of the editor's current selection.
pub(crate) fn prepare_render_source(
    source: &DynamicImage,
    adjustments: &Value,
    is_raw: bool,
) -> Result<PreparedPhoto, String> {
    prepare_render_source_checked(source, adjustments, is_raw, || Ok(()))
}

pub(crate) fn prepare_render_source_checked(
    source: &DynamicImage,
    adjustments: &Value,
    is_raw: bool,
    mut check_cancelled: impl FnMut() -> Result<(), String>,
) -> Result<PreparedPhoto, String> {
    check_cancelled()?;
    if source.width() == 0 || source.height() == 0 {
        return Err("Source dimensions must be nonzero".into());
    }
    let (image, crop_offset) = crate::apply_all_transformations(Cow::Borrowed(source), adjustments);
    let crop_offset = (crop_offset.0.round(), crop_offset.1.round());
    let image = image.into_owned();
    check_cancelled()?;
    let masks = crate::marigold_surface::render_masks(adjustments)
        .into_iter()
        .filter(|mask| mask.visible)
        .collect::<Vec<_>>();
    let bitmaps = source_masks(
        MaskRequest {
            definitions: &masks,
            source,
            adjustments,
            is_raw,
            dimensions: image.dimensions(),
            scale: 1.0,
            crop_offset,
        },
        check_cancelled,
    )?;
    if bitmaps.len() != masks.len() {
        return Err("Could not rasterize every visible mask".into());
    }
    Ok(PreparedPhoto {
        image,
        masks,
        bitmaps,
        crop_offset,
    })
}

pub(crate) fn export_precision(format: &str, bit_depth: TiffBitDepth) -> RenderOutputPrecision {
    if matches!(format.to_ascii_lowercase().as_str(), "tif" | "tiff")
        && bit_depth == TiffBitDepth::Sixteen
    {
        RenderOutputPrecision::SixteenBit
    } else {
        RenderOutputPrecision::EightBit
    }
}

pub(crate) struct FinalRenderRequest<'a> {
    pub image: &'a DynamicImage,
    pub native: RenderRequest<'a>,
    pub precision: RenderOutputPrecision,
    pub cache_key: u64,
    pub caller: &'a str,
}

pub(crate) fn render_final(
    context: &GpuContext,
    state: &tauri::State<'_, AppState>,
    request: FinalRenderRequest<'_>,
) -> Result<DynamicImage, String> {
    match request.precision {
        RenderOutputPrecision::SixteenBit => {
            crate::gpu_processing::process_and_get_dynamic_image_high_precision(
                context,
                request.image,
                request.native,
            )
        }
        RenderOutputPrecision::EightBit => {
            crate::gpu_processing::process_and_get_dynamic_image_with_precision(
                context,
                state,
                request.image,
                request.cache_key,
                request.native,
                request.caller,
                request.precision,
            )
        }
    }
}

pub(crate) struct ExportRequest<'a> {
    pub image: &'a DynamicImage,
    pub format: &'a str,
    pub quality: u8,
    pub bit_depth: TiffBitDepth,
}

pub(crate) fn encode_export(request: ExportRequest<'_>) -> Result<Vec<u8>, String> {
    crate::export_processing::encode_native_with_options(
        request.image,
        request.format,
        request.quality,
        request.bit_depth,
        None,
    )
}

pub(crate) fn effective_adjustments_with_render_options(
    request: AdjustRequest<'_>,
    as_shot: crate::as_shot::AsShot,
    render: crate::image_processing::RenderOptions,
) -> AllAdjustments {
    let mut resolved = crate::image_processing::get_all_adjustments_with_render_options(
        request.adjustments,
        request.is_raw,
        as_shot,
        render,
    );
    resolved.global.show_clipping = u32::from(request.show_clipping);
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use serde_json::json;

    #[test]
    fn versioned_registry_routes_every_core_automation_method() {
        assert_eq!(contract().version, 1);
        assert_eq!(contract().commands.len(), 5);
        for command in contract().commands {
            assert!(!command.desktop_commands.is_empty());
            for method in command.mcp_methods {
                assert_eq!(command_for_mcp(method), Some(command.id));
            }
        }
        assert_eq!(command_for_mcp("unknown"), None);
    }

    #[test]
    fn final_adjustments_suppress_display_clipping_and_accept_legacy_fields() {
        let adjustments = json!({"exposure":0.5,"showClipping":true,"legacyField":1});
        let display = effective_adjustments(AdjustRequest {
            adjustments: &adjustments,
            is_raw: false,
            tonemapper_override: None,
            show_clipping: true,
        });
        let final_values = final_adjustments(&adjustments, false, None);
        assert_eq!(display.global.show_clipping, 1);
        assert_eq!(final_values.global.show_clipping, 0);
        assert_eq!(display.global.exposure, final_values.global.exposure);
    }

    #[test]
    fn preparation_binds_masks_to_source_and_omits_hidden_definitions() {
        let source = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(12, 8, Rgb([128, 128, 128])));
        let mask = json!({"id":"visible","name":"All","visible":true,"invert":false,"opacity":100,
            "adjustments":{},"subMasks":[{"id":"all","type":"all","visible":true,"invert":false,
                "opacity":100,"mode":"additive","parameters":{}}]});
        let mut hidden = mask.clone();
        hidden["id"] = json!("hidden");
        hidden["visible"] = json!(false);
        let prepared =
            prepare_render_source(&source, &json!({"masks":[hidden,mask]}), false).unwrap();
        assert_eq!(prepared.image.dimensions(), source.dimensions());
        assert_eq!(prepared.masks.len(), 1);
        assert_eq!(prepared.masks[0].id, "visible");
        assert_eq!(prepared.bitmaps.len(), 1);
        assert!(prepared.bitmaps[0].pixels().all(|pixel| pixel[0] == 255));
    }

    #[test]
    fn preparation_rejects_a_visible_mask_without_a_bitmap() {
        let source = DynamicImage::new_rgb8(12, 8);
        let adjustments = json!({"masks":[{"id":"empty","name":"Empty","visible":true,
            "invert":false,"opacity":100,"adjustments":{},"subMasks":[]}]});
        assert!(prepare_render_source(&source, &adjustments, false).is_err());
    }
}
