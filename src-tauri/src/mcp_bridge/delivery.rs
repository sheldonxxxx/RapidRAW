//! Explicit sRGB profile embedding for the native display-referred raster.
//! This labels actual sRGB output; it never assigns an unrelated source profile.
use super::Result;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat};
use std::io::Cursor;

pub(super) fn supports_icc(format: &str) -> bool {
    matches!(format, "jpeg" | "png" | "tiff" | "webp")
}

pub(super) fn srgb_profile() -> Result<Vec<u8>> {
    static PROFILE: std::sync::OnceLock<Result<Vec<u8>>> = std::sync::OnceLock::new();
    PROFILE
        .get_or_init(|| {
            let mut profile = moxcms::ColorProfile::new_srgb();
            // ICC v4 display profiles use the exact ICC D50 PCS white point,
            // with sRGB's D65 colorimetry Bradford-adapted into that PCS.
            // https://www.color.org/whyd50/ and https://registry.color.org/rgb-registry/srgb
            let d50 = moxcms::Xyzd {
                x: 0.9642,
                y: 1.0,
                z: 0.8249,
            };
            let adaptation = moxcms::adaption_matrix_d(
                moxcms::Xyz {
                    x: (0.3127 / 0.3290) as f32,
                    y: 1.0,
                    z: ((1.0 - 0.3127 - 0.3290) / 0.3290) as f32,
                },
                moxcms::Xyz {
                    x: d50.x as f32,
                    y: 1.0,
                    z: d50.z as f32,
                },
            );
            // Linear sRGB matrix computed from the IEC primaries and D65 xy.
            let colorants = adaptation.mat_mul(moxcms::Matrix3d {
                v: [
                    [
                        0.4123907992659595,
                        0.357_584_339_383_878,
                        0.1804807884018343,
                    ],
                    [
                        0.2126390058715104,
                        0.715_168_678_767_756,
                        0.0721923153607337,
                    ],
                    [
                        0.0193308187155919,
                        0.119_194_779_794_626,
                        0.9505321522496607,
                    ],
                ],
            });
            let colorant = |column| moxcms::Xyzd {
                x: colorants.v[0][column],
                y: colorants.v[1][column],
                z: colorants.v[2][column],
            };
            profile.red_colorant = colorant(0);
            profile.green_colorant = colorant(1);
            profile.blue_colorant = colorant(2);
            profile.white_point = d50;
            profile.media_white_point = Some(d50);
            profile.chromatic_adaptation = Some(adaptation);
            // ICC matrix/TRCs fully describe these full-range RGB samples.
            profile.cicp = None;
            let bytes = profile
                .encode()
                .map_err(|e| format!("COLOR_PROFILE_FAILED: {e}"))?;
            let mut bytes = align_profile_tags(&bytes)?;
            // Profile creation metadata is fixed for reproducible encoded delivery.
            for (slot, value) in bytes[24..36]
                .as_chunks_mut::<2>()
                .0
                .iter_mut()
                .zip([2000u16, 1, 1, 0, 0, 0])
            {
                slot.copy_from_slice(&value.to_be_bytes());
            }
            Ok(bytes)
        })
        .clone()
}

// moxcms 0.8's encoder can place a tag after an unpadded text payload. Repack
// each complete payload to an ICC-required four-byte boundary; sizes exclude
// padding and the profile size includes it. Never change the tag contents.
fn align_profile_tags(bytes: &[u8]) -> Result<Vec<u8>> {
    let invalid = || "COLOR_PROFILE_FAILED: Invalid generated ICC tag table".to_string();
    let read_u32 = |at: usize| -> Result<u32> {
        Ok(u32::from_be_bytes(
            bytes
                .get(at..at + 4)
                .ok_or_else(invalid)?
                .try_into()
                .map_err(|_| invalid())?,
        ))
    };
    let count = read_u32(128)? as usize;
    if count > 128 {
        return Err(invalid());
    }
    let table_end = 132 + count * 12;
    let mut output = bytes.get(..table_end).ok_or_else(invalid)?.to_vec();
    for i in 0..count {
        let entry = 132 + i * 12;
        let offset = read_u32(entry + 4)? as usize;
        let length = read_u32(entry + 8)? as usize;
        if offset < table_end {
            return Err(invalid());
        }
        let data = bytes
            .get(offset..offset.checked_add(length).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        output.resize(output.len().div_ceil(4) * 4, 0);
        let new_offset = u32::try_from(output.len()).map_err(|_| invalid())?;
        output[entry + 4..entry + 8].copy_from_slice(&new_offset.to_be_bytes());
        output.extend_from_slice(data);
    }
    output.resize(output.len().div_ceil(4) * 4, 0);
    let size = u32::try_from(output.len()).map_err(|_| invalid())?;
    output[..4].copy_from_slice(&size.to_be_bytes());
    Ok(output)
}

pub(super) fn encode_profiled_raster(
    image: &DynamicImage,
    format: &str,
    depth: u32,
) -> Result<Vec<u8>> {
    let profile = srgb_profile()?;
    let raster = if depth == 16 {
        DynamicImage::ImageRgb16(image.to_rgb16())
    } else {
        DynamicImage::ImageRgb8(image.to_rgb8())
    };
    let mut output = Cursor::new(Vec::new());
    match format {
        "png" => {
            let mut encoder = image::codecs::png::PngEncoder::new(&mut output);
            encoder
                .set_icc_profile(profile)
                .map_err(|e| e.to_string())?;
            raster
                .write_with_encoder(encoder)
                .map_err(|e| e.to_string())?;
        }
        "tiff" => {
            let mut encoder = image::codecs::tiff::TiffEncoder::new(&mut output);
            encoder
                .set_icc_profile(profile)
                .map_err(|e| e.to_string())?;
            raster
                .write_with_encoder(encoder)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err("INVALID_ARGUMENT: Profiled raster encoder supports PNG/TIFF".into()),
    }
    Ok(output.into_inner())
}

pub(super) fn add_profile(bytes: &mut Vec<u8>, format: &str) -> Result<()> {
    let profile = srgb_profile()?;
    match format {
        "jpeg" => {
            if !bytes.starts_with(&[0xff, 0xd8]) {
                return Err("INVALID_EXPORT: JPEG signature missing".into());
            }
            // ICC APP2 chunks have a 14-byte identifier/sequence prefix.
            let parts = profile.chunks(65519).collect::<Vec<_>>();
            if parts.len() > 255 {
                return Err("COLOR_PROFILE_FAILED: ICC profile is too large".into());
            }
            let mut segments = Vec::new();
            for (i, part) in parts.iter().enumerate() {
                segments.extend_from_slice(&[0xff, 0xe2]);
                segments.extend_from_slice(&((part.len() + 16) as u16).to_be_bytes());
                segments.extend_from_slice(b"ICC_PROFILE\0");
                segments.extend_from_slice(&[(i + 1) as u8, parts.len() as u8]);
                segments.extend_from_slice(part);
            }
            bytes.splice(2..2, segments);
        }
        "webp" => {
            if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
                return Err("INVALID_EXPORT: WebP signature missing".into());
            }
            // Caller normalizes VP8X after adding the ICCP chunk.
            let mut chunk = b"ICCP".to_vec();
            chunk.extend_from_slice(&(profile.len() as u32).to_le_bytes());
            chunk.extend_from_slice(&profile);
            if profile.len() % 2 != 0 {
                chunk.push(0);
            }
            let at = if bytes.get(12..16) == Some(b"VP8X") {
                30
            } else {
                12
            };
            bytes.splice(at..at, chunk);
            let size = u32::try_from(bytes.len() - 8)
                .map_err(|_| "INVALID_EXPORT: WebP container too large")?;
            bytes[4..8].copy_from_slice(&size.to_le_bytes());
        }
        _ => return Err("INVALID_ARGUMENT: Inline profile insertion supports JPEG/WebP".into()),
    }
    Ok(())
}

pub(super) fn verify_profile(bytes: &[u8], format: &str) -> Result<bool> {
    if format == "tiff" {
        let expected = srgb_profile()?;
        return Ok(tiff_profile(bytes)?.is_some_and(|profile| profile == expected));
    }
    let format = match format {
        "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        "tiff" => ImageFormat::Tiff,
        "webp" => ImageFormat::WebP,
        _ => return Ok(false),
    };
    let mut decoder = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_decoder()
        .map_err(|e| format!("EXPORT_VERIFICATION_FAILED: {e}"))?;
    let embedded = decoder
        .icc_profile()
        .map_err(|e| format!("EXPORT_VERIFICATION_FAILED: {e}"))?;
    let expected = srgb_profile()?;
    Ok(embedded.as_ref().is_some_and(|p| p == &expected))
}

// The image crate's TIFF ICC accessor can return None for valid encoded ICC
// fields. Verify the actual IFD entry and its full payload without re-encoding.
fn tiff_profile(bytes: &[u8]) -> Result<Option<&[u8]>> {
    let invalid = || "EXPORT_VERIFICATION_FAILED: Invalid TIFF ICC directory".to_string();
    let little = match bytes.get(..4) {
        Some(b"II\x2a\x00") => true,
        Some(b"MM\x00\x2a") => false,
        _ => return Err(invalid()),
    };
    let u16_at = |at: usize| -> Result<u16> {
        let v: [u8; 2] = bytes
            .get(at..at.checked_add(2).ok_or_else(invalid)?)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?;
        Ok(if little {
            u16::from_le_bytes(v)
        } else {
            u16::from_be_bytes(v)
        })
    };
    let u32_at = |at: usize| -> Result<u32> {
        let v: [u8; 4] = bytes
            .get(at..at.checked_add(4).ok_or_else(invalid)?)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?;
        Ok(if little {
            u32::from_le_bytes(v)
        } else {
            u32::from_be_bytes(v)
        })
    };
    let directory = u32_at(4)? as usize;
    let count = u16_at(directory)? as usize;
    let mut profile = None;
    for i in 0..count {
        let entry = directory.checked_add(2 + 12 * i).ok_or_else(invalid)?;
        let tag = u16_at(entry)?;
        let kind = u16_at(entry + 2)?;
        let length = u32_at(entry + 4)? as usize;
        let offset = u32_at(entry + 8)? as usize;
        if tag == 34675 {
            if profile.is_some() || ![1, 7].contains(&kind) || length < 128 {
                return Err(invalid());
            }
            profile = Some(
                bytes
                    .get(offset..offset.checked_add(length).ok_or_else(invalid)?)
                    .ok_or_else(invalid)?,
            );
        }
    }
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn srgb_profile_has_aligned_tags_and_consistent_d50_colorimetry() {
        let bytes = srgb_profile().unwrap();
        let number = |at| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap());
        assert_eq!(number(0) as usize, bytes.len());
        assert_eq!(bytes.len() % 4, 0);
        assert_eq!(
            [number(68), number(72), number(76)],
            [0xf6d6, 0x10000, 0xd32d]
        );
        for i in 0..number(128) as usize {
            let entry = 132 + 12 * i;
            assert_eq!(number(entry + 4) % 4, 0);
            assert!((number(entry + 4) + number(entry + 8)) as usize <= bytes.len());
        }
        let decoded = moxcms::ColorProfile::new_from_slice(&bytes).unwrap();
        let expected = [0.9642, 1.0, 0.8249];
        let matrix = decoded.rgb_to_xyz_matrix();
        for (row, white) in matrix.v.iter().zip(expected) {
            assert!((row.iter().sum::<f64>() - white).abs() < 4.0 / 65536.0);
        }
        let chad = decoded.chromatic_adaptation.unwrap();
        let source_white = [0.3127 / 0.3290, 1.0, (1.0 - 0.3127 - 0.3290) / 0.3290];
        for (row, white) in chad.v.iter().zip(expected) {
            let adapted: f64 = row.iter().zip(source_white).map(|(a, b)| a * b).sum();
            assert!((adapted - white).abs() < 4.0 / 65536.0);
        }
        assert_eq!(srgb_profile().unwrap(), bytes);
    }
    #[test]
    fn encoded_profiles_roundtrip_without_changing_raster_depth() {
        let image = DynamicImage::ImageRgb16(image::ImageBuffer::from_fn(23, 11, |x, y| {
            image::Rgb([(x * 2000) as u16, (y * 3000) as u16, 12345])
        }));
        for format in ["png", "tiff"] {
            let bytes = encode_profiled_raster(&image, format, 16).unwrap();
            assert!(
                verify_profile(&bytes, format).unwrap(),
                "ICC missing or changed in {format}"
            );
            assert_eq!(
                image::load_from_memory(&bytes).unwrap().to_rgb16(),
                image.to_rgb16()
            );
        }
    }
    #[test]
    fn jpeg_profile_preserves_encoded_scan() {
        let image = DynamicImage::new_rgb8(8, 8);
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Jpeg).unwrap();
        let mut bytes = bytes.into_inner();
        let original = image::load_from_memory(&bytes).unwrap().to_rgb8();
        add_profile(&mut bytes, "jpeg").unwrap();
        assert!(verify_profile(&bytes, "jpeg").unwrap());
        assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgb8(), original);
    }
}
