//! Reproducible sRGB ICC profile for rendered desktop and MCP output.
type Result<T> = std::result::Result<T, String>;

pub(crate) fn srgb_profile() -> Result<Vec<u8>> {
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
