//! Generated fixtures exercise processing contracts, not photographic quality.

use super::{
    GpuProcessor, RenderOutputPrecision, RenderRequest, RenderedPixels, Roi,
    process_and_get_dynamic_image_high_precision, to_rgba_f16,
};
use crate::engine_commands::{final_adjustments, prepare_render_source};
use crate::image_processing::GpuContext;
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgb};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};
use wgpu::util::{DeviceExt, TextureDataOrder};

fn mask(id: &str, visible: bool, adjustments: Value, sub_masks: Value) -> Value {
    json!({
        "id": id, "name": id, "visible": visible, "invert": false,
        "adjustments": adjustments, "subMasks": sub_masks,
    })
}

fn component(id: &str, kind: &str, mode: &str, parameters: Value) -> Value {
    json!({
        "id": id, "type": kind, "mode": mode, "visible": true,
        "parameters": parameters,
    })
}

fn asymmetric_source() -> DynamicImage {
    DynamicImage::ImageRgb16(ImageBuffer::from_fn(64, 48, |x, y| {
        Rgb([
            (1000 + x * 503 + y * 17) as u16,
            (2000 + y * 701 + x * 13) as u16,
            (3000 + x * 127 + y * 293) as u16,
        ])
    }))
}

#[test]
fn fractional_crop_rotation_and_flips_match_independent_source_coordinates() {
    let source = asymmetric_source();
    let original = source.to_rgb16();
    for steps in 0..4 {
        for horizontal in [false, true] {
            for vertical in [false, true] {
                let adjustments = json!({
                    "orientationSteps": steps, "flipHorizontal": horizontal,
                    "flipVertical": vertical,
                    "crop": {"unit": "px", "x": 2.4, "y": 3.6, "width": 15.4, "height": 12.6},
                });
                let prepared = prepare_render_source(&source, &adjustments, false).unwrap();
                assert_eq!(prepared.image.dimensions(), (15, 13));
                assert_eq!(prepared.crop_offset, (2.0, 4.0));
                let (preview_source, preview_offset) =
                    crate::adjustment_utils::apply_spatial_transformations(
                        std::borrow::Cow::Borrowed(&source),
                        &adjustments,
                    );
                assert_eq!(
                    preview_offset,
                    (2.0, 4.0),
                    "desktop preview must use the sampled crop origin"
                );
                assert_eq!(preview_source.dimensions(), (15, 13));
                let preview_pixels = preview_source.to_rgb16();
                let output = prepared.image.to_rgb16();
                let (rotated_width, rotated_height) =
                    if steps % 2 == 0 { (64, 48) } else { (48, 64) };
                for (x, y, pixel) in output.enumerate_pixels() {
                    let unflipped_x = if horizontal {
                        rotated_width - 1 - (x + 2)
                    } else {
                        x + 2
                    };
                    let unflipped_y = if vertical {
                        rotated_height - 1 - (y + 4)
                    } else {
                        y + 4
                    };
                    // Inverse integer rotation, calculated independently of the native helpers.
                    let (source_x, source_y) = match steps {
                        0 => (unflipped_x, unflipped_y),
                        1 => (unflipped_y, 47 - unflipped_x),
                        2 => (63 - unflipped_x, 47 - unflipped_y),
                        3 => (63 - unflipped_y, unflipped_x),
                        _ => unreachable!(),
                    };
                    assert_eq!(
                        pixel,
                        original.get_pixel(source_x, source_y),
                        "rotation={steps}, horizontal={horizontal}, vertical={vertical}, output=({x},{y})"
                    );
                    assert_eq!(
                        preview_pixels.get_pixel(x, y),
                        original.get_pixel(source_x, source_y)
                    );
                }
            }
        }
    }
    assert_eq!(
        source.to_rgb16(),
        original,
        "preparation must preserve its captured source"
    );
}

#[test]
fn unapplied_crops_preserve_source_pixels_and_zero_origin() {
    let source = asymmetric_source();
    let original = source.to_rgb16();
    for crop in [
        Value::Null,
        json!({"unit": "px", "x": 64, "y": 0, "width": 1, "height": 1}),
        json!({"unit": "px", "x": 2.4, "y": 3.6, "width": 0, "height": 13}),
        json!({"unit": "px", "x": "invalid", "y": 0, "width": 15, "height": 13}),
    ] {
        let adjustments = json!({"crop": crop});
        let (preview, offset) = crate::adjustment_utils::apply_spatial_transformations(
            std::borrow::Cow::Borrowed(&source),
            &adjustments,
        );
        assert_eq!(
            offset,
            (0.0, 0.0),
            "unapplied crop: {}",
            adjustments["crop"]
        );
        assert_eq!(preview.to_rgb16(), original);
        let prepared = prepare_render_source(&source, &adjustments, false).unwrap();
        assert_eq!(prepared.crop_offset, (0.0, 0.0));
        assert_eq!(prepared.image.to_rgb16(), original);
    }
}

#[test]
fn crop_relative_mask_composition_preserves_order_and_protected_pixels() {
    let source = asymmetric_source();
    let mut radial = mask(
        "radial",
        true,
        json!({"exposure": 0.4}),
        json!([
            component(
                "ellipse",
                "radial",
                "additive",
                json!({
                    "centerX": 8, "centerY": 10, "radiusX": 4, "radiusY": 4, "rotation": 0, "feather": 0,
                })
            ),
            component(
                "hole",
                "brush",
                "subtractive",
                json!({"lines": [{
                    "tool": "brush", "brushSize": 2, "feather": 0,
                    "points": [{"x": 8, "y": 10}],
                }]})
            ),
        ]),
    );
    radial["opacity"] = json!(50);
    let brush = mask(
        "brush",
        true,
        json!({"exposure": -0.4}),
        json!([component(
            "stroke",
            "brush",
            "additive",
            json!({"lines": [{
                "tool": "brush", "brushSize": 2, "feather": 0,
                "points": [{"x": 14, "y": 12}, {"x": 16, "y": 12}],
            }]})
        ),]),
    );
    let hidden = mask(
        "hidden",
        false,
        json!({"exposure": 4}),
        json!([component("all", "all", "additive", json!({})),]),
    );
    let adjustments = json!({
        "crop": {"unit": "px", "x": 2.4, "y": 3.6, "width": 15, "height": 13},
        "masks": [hidden, radial, brush], "showClipping": true,
    });
    let prepared = prepare_render_source(&source, &adjustments, false).unwrap();
    assert_eq!(
        prepared
            .masks
            .iter()
            .map(|mask| mask.id.as_str())
            .collect::<Vec<_>>(),
        ["radial", "brush"]
    );
    assert_eq!(prepared.bitmaps.len(), 2);
    assert!(
        prepared
            .bitmaps
            .iter()
            .all(|bitmap| bitmap.dimensions() == (15, 13))
    );
    assert_eq!(
        prepared.bitmaps[0].get_pixel(6, 6)[0],
        0,
        "subtractive brush removes the ellipse centre"
    );
    assert_eq!(
        prepared.bitmaps[0].get_pixel(9, 6)[0],
        127,
        "retained ellipse follows rounded crop origin and opacity"
    );
    assert_eq!(
        prepared.bitmaps[0].get_pixel(11, 6)[0],
        0,
        "outside the ellipse stays protected"
    );
    assert_eq!(prepared.bitmaps[1].get_pixel(12, 8)[0], 255);
    assert_eq!(prepared.bitmaps[1].get_pixel(14, 8)[0], 255);
    assert_eq!(prepared.bitmaps[1].get_pixel(12, 11)[0], 0);
    let effective = final_adjustments(&adjustments, false, None);
    assert_eq!(effective.mask_count, 2);
    assert_eq!(effective.mask_adjustments[0].exposure, 0.5);
    assert_eq!(effective.mask_adjustments[1].exposure, -0.5);
    assert_eq!(effective.global.show_clipping, 0);
}

#[test]
fn cropped_color_mask_uses_captured_source_after_another_photo_is_prepared() {
    let captured = DynamicImage::ImageRgb8(ImageBuffer::from_fn(32, 24, |x, _| {
        if x < 8 {
            Rgb([255, 0, 0])
        } else {
            Rgb([0, 0, 255])
        }
    }));
    let unrelated = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(32, 24, Rgb([0, 255, 0])));
    let captured_before = captured.to_rgb8();
    let unrelated_before = unrelated.to_rgb8();
    let adjustments = json!({
        "crop": {"unit": "px", "x": 2.4, "y": 3.6, "width": 15, "height": 13},
        "masks": [mask("sample", true, json!({}), json!([
            component("color", "color", "additive", json!({"targetX": 3, "targetY": 5, "tolerance": 10})),
        ]))],
    });
    let first = prepare_render_source(&captured, &adjustments, false).unwrap();
    let other = prepare_render_source(&unrelated, &adjustments, false).unwrap();
    let again = prepare_render_source(&captured, &adjustments, false).unwrap();
    assert_eq!(first.bitmaps[0].get_pixel(0, 0)[0], 255);
    assert_eq!(first.bitmaps[0].get_pixel(6, 0)[0], 0);
    assert_eq!(other.bitmaps[0].get_pixel(6, 0)[0], 255);
    assert_eq!(first.bitmaps, again.bitmaps);
    assert_eq!(captured.to_rgb8(), captured_before);
    assert_eq!(unrelated.to_rgb8(), unrelated_before);
}

#[test]
fn empty_sources_and_unrasterized_visible_masks_fail_explicitly() {
    assert!(prepare_render_source(&DynamicImage::new_rgb8(0, 1), &json!({}), false).is_err());
    let adjustments = json!({"masks": [mask("missing", true, json!({}), json!([]))]});
    let error = prepare_render_source(&asymmetric_source(), &adjustments, false)
        .err()
        .unwrap();
    assert!(
        error.contains("Could not rasterize every visible mask"),
        "{error}"
    );
}

#[test]
fn render_contract_rejects_invalid_regions_masks_and_allocation_limits() {
    let effective = final_adjustments(&json!({"exposure": 0.2}), false, None);
    let request = |roi| RenderRequest {
        adjustments: effective,
        mask_bitmaps: &[],
        lut: None,
        roi,
    };
    for roi in [
        Roi {
            x: 16,
            y: 0,
            width: 1,
            height: 1,
        },
        Roi {
            x: 0,
            y: 0,
            width: 0,
            height: 1,
        },
        Roi {
            x: u32::MAX,
            y: 0,
            width: 2,
            height: 1,
        },
    ] {
        assert!(super::validate_precision_request(16, 8, 4096, &request(Some(roi))).is_err());
    }
    let mut missing = request(None);
    missing.adjustments.mask_count = 1;
    assert!(super::validate_precision_request(16, 8, 4096, &missing).is_err());
    let mismatched = [image::GrayImage::new(15, 8)];
    missing.mask_bitmaps = &mismatched;
    assert!(super::validate_precision_request(16, 8, 4096, &missing).is_err());
    let error = super::ordinary_texture_extent(257, 8, 511, &request(None)).unwrap_err();
    assert!(error.contains("257x8") && error.contains("511"), "{error}");
    assert!(super::validate_precision_request(0, 8, 4096, &request(None)).is_err());
}

fn gpu_context() -> GpuContext {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(
        instance.request_adapter(&wgpu::RequestAdapterOptions::default()),
    )
    .expect(
        "GPU adapter required for the engine regression; unavailable adapters must fail this gate",
    );
    eprintln!("engine regression adapter: {:?}", adapter.get_info());
    let limits = adapter.limits();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: limits.clone(),
        ..Default::default()
    }))
    .unwrap();
    GpuContext {
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits,
        display: Arc::new(std::sync::Mutex::new(None)),
    }
}

// Reference uses the published sRGB transfer function and exposure in stops;
// it does not call native colour processing or read shader output for expectations.
fn srgb_exposure_reference(sample: u16, stops: f64) -> u16 {
    let encoded = f64::from(sample) / 65535.0;
    let linear = if encoded <= 0.04045 {
        encoded / 12.92
    } else {
        ((encoded + 0.055) / 1.055).powf(2.4)
    };
    let exposed = (linear * 2f64.powf(stops)).clamp(0.0, 1.0);
    let encoded = if exposed <= 0.0031308 {
        exposed * 12.92
    } else {
        1.055 * exposed.powf(1.0 / 2.4) - 0.055
    };
    (encoded * 65535.0).round() as u16
}

#[test]
#[ignore = "requires a GPU adapter; run this named regression with --ignored --exact"]
fn gpu_gui_mcp_render_contract_matches_cpu_reference() {
    let context = gpu_context();
    let source = DynamicImage::ImageRgb16(ImageBuffer::from_fn(1031, 15, |x, y| {
        Rgb([
            32000 + x as u16,
            20000 + y as u16 * 431,
            1000 + x as u16 * 17,
        ])
    }));
    let mut local = mask(
        "local",
        true,
        json!({"exposure": 0.4}),
        json!([component(
            "ellipse",
            "radial",
            "additive",
            json!({
                "centerX": 130, "centerY": 8, "radiusX": 256, "radiusY": 128, "rotation": 0, "feather": 0,
            })
        ),]),
    );
    local["opacity"] = json!(50);
    let adjustments = json!({
        "exposure": 0.2, "showClipping": true,
        "crop": {"unit": "px", "x": 2.4, "y": 3.6, "width": 1025, "height": 9},
        "masks": [local],
    });
    let prepared = prepare_render_source(&source, &adjustments, false).unwrap();
    let effective = final_adjustments(&adjustments, false, None);
    assert_eq!(effective.global.exposure, 0.25);
    assert_eq!(effective.mask_adjustments[0].exposure, 0.5);
    assert_eq!(prepared.bitmaps[0].get_pixel(128, 4)[0], 127);
    assert_eq!(prepared.bitmaps[0].get_pixel(800, 4)[0], 0);
    let request = |roi| RenderRequest {
        adjustments: effective,
        mask_bitmaps: &prepared.bitmaps,
        lut: None,
        roi,
    };
    assert!(
        process_and_get_dynamic_image_high_precision(
            &context,
            &prepared.image,
            request(Some(Roi {
                x: u32::MAX,
                y: 0,
                width: 2,
                height: 1,
            }))
        )
        .is_err(),
        "public native render must reject an overflowing region"
    );
    let final_image =
        process_and_get_dynamic_image_high_precision(&context, &prepared.image, request(None))
            .unwrap();
    assert_eq!(final_image.color(), image::ColorType::Rgba16);
    let final_pixels = final_image.to_rgba16();
    let original_pixels = source.to_rgb16();
    let mut maximum_reference_error = 0;
    for (x, y, pixel) in final_pixels.enumerate_pixels() {
        let ellipse_distance = ((f64::from(x) - 128.0).powi(2) / 256f64.powi(2)
            + (f64::from(y) - 4.0).powi(2) / 128f64.powi(2))
        .sqrt();
        // Exclude the narrow rasterizer transition; interior and protected
        // pixels have independently known coverage rather than sampled masks.
        if (0.99..1.02).contains(&ellipse_distance) {
            continue;
        }
        let stops = 0.25
            + if ellipse_distance < 0.99 {
                0.5 * 127.0 / 255.0
            } else {
                0.0
            };
        let original = original_pixels.get_pixel(x + 2, y + 4);
        for channel in 0..3 {
            let expected = srgb_exposure_reference(original[channel], stops);
            maximum_reference_error =
                maximum_reference_error.max(pixel[channel].abs_diff(expected));
        }
        assert_eq!(pixel[3], 65535);
    }
    // Eight u16 units allow GPU float32 pow/colour arithmetic across drivers;
    // an eight-bit or half-float collapse exceeds this bound on this ramp.
    assert!(
        maximum_reference_error <= 8,
        "sRGB exposure/mask reference error: {maximum_reference_error}"
    );
    let levels: HashSet<_> = (400..1025)
        .map(|x| final_pixels.get_pixel(x, 4)[0])
        .collect();
    assert!(
        levels.len() > 600,
        "only {} protected ramp levels survived",
        levels.len()
    );

    let texels = to_rgba_f16(&prepared.image);
    let (width, height) = prepared.image.dimensions();
    let texture = context.device.create_texture_with_data(
        &context.queue,
        &wgpu::TextureDescriptor {
            label: Some("Engine regression interactive input"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        TextureDataOrder::MipMajor,
        bytemuck::cast_slice(&texels),
    );
    let processor = GpuProcessor::new(
        context.clone(),
        width.div_ceil(256) * 256,
        height.div_ceil(256) * 256,
    )
    .unwrap();
    let (interactive, out_width, out_height, out_x, out_y) = processor
        .run(
            &texture.create_view(&Default::default()),
            None,
            None,
            width,
            height,
            request(None),
            false,
            RenderOutputPrecision::EightBit,
            None,
        )
        .unwrap();
    assert_eq!((out_width, out_height, out_x, out_y), (width, height, 0, 0));
    let RenderedPixels::U8(interactive) = interactive else {
        panic!("interactive path must return eight-bit pixels")
    };
    assert_eq!(interactive.len(), width as usize * height as usize * 4);
    let mut maximum_preview_error = 0;
    for (preview, final_pixel) in interactive
        .as_chunks::<4>()
        .0
        .iter()
        .zip(final_pixels.pixels())
    {
        for channel in 0..3 {
            let quantized = ((u32::from(final_pixel[channel]) + 128) / 257) as u8;
            maximum_preview_error = maximum_preview_error.max(preview[channel].abs_diff(quantized));
        }
        assert_eq!(preview[3], 255);
    }
    // Interactive input uses f16 and adds <= one eight-bit dither level;
    // this bounded simple grade permits at most two final display levels.
    assert!(
        maximum_preview_error <= 2,
        "interactive/final output error: {maximum_preview_error}"
    );

    let roi = Roi {
        x: 377,
        y: 2,
        width: 31,
        height: 5,
    };
    let detail =
        process_and_get_dynamic_image_high_precision(&context, &prepared.image, request(Some(roi)))
            .unwrap()
            .to_rgba16();
    for (x, y, pixel) in detail.enumerate_pixels() {
        assert_eq!(
            pixel,
            final_pixels.get_pixel(x + roi.x, y + roi.y),
            "ROI changes native pixels at ({x},{y})"
        );
    }
    for format in ["png", "tiff"] {
        let bytes =
            crate::delivery::encode_profiled_raster(&final_image, format, 16, format == "png")
                .unwrap();
        crate::delivery::verify_raster_header(&bytes, format, (width, height), 16).unwrap();
        assert!(crate::delivery::verify_profile(&bytes, format).unwrap());
        assert_eq!(
            image::load_from_memory(&bytes).unwrap().to_rgb16(),
            final_image.to_rgb16(),
            "{format} delivery changes rendered samples"
        );
    }
    eprintln!(
        "engine regression maximum errors: CPU reference={maximum_reference_error}/65535, interactive={maximum_preview_error}/255; sixteen-bit levels={}",
        levels.len()
    );
}
