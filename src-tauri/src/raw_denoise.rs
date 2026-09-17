//! Bayer-domain Nonlocal inference. Decoding and DNG writing use the editor's
//! RAW library; the CUDA subprocess only sees normalized packed sensor planes.
use crate::denoising::DenoiseControl;
use anyhow::{Context, Result, bail, ensure};
use rawler::{
    decoders::{RawDecodeParams, RawMetadata},
    dng::{
        CropMode, DNG_VERSION_V1_4, DngCompression, DngPhotometricConversion, writer::DngWriter,
    },
    imgop::{Dim2, Point, Rect},
    rawimage::{RawImage, RawImageData, RawPhotometricInterpretation},
    rawsource::RawSource,
    tags::{ExifTag, TiffCommonTag},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const MODEL_SHA: &str = "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad";
const ALGORITHM: &str = "nonlocal-raw-v1";

pub(crate) fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn configured_path(name: &str) -> Result<PathBuf> {
    let path = PathBuf::from(
        std::env::var_os(name)
            .with_context(|| format!("NONLOCAL_UNAVAILABLE: Set {name} on the GPU host"))?,
    );
    ensure!(
        path.is_absolute() && path.is_file(),
        "NONLOCAL_UNAVAILABLE: {name} must name an existing absolute file"
    );
    Ok(path)
}

pub(crate) fn configuration() -> Result<(PathBuf, PathBuf)> {
    let python = configured_path("RAPIDRAW_NONLOCAL_PYTHON")?;
    let checkpoint = configured_path("RAPIDRAW_NONLOCAL_CHECKPOINT")?;
    ensure!(
        hash_file(&checkpoint)? == MODEL_SHA,
        "NONLOCAL_UNAVAILABLE: Checkpoint checksum mismatch"
    );
    Ok((python, checkpoint))
}

pub(crate) fn status() -> Value {
    match configuration() {
        Ok(_) => {
            json!({"configured":true,"weights_verified":true,"runtime":"pytorch-cuda","cuda_verified":false,
            "method":"nonlocal","entrypoint":"start_denoise","output":"bayer-dng","model_sha256":MODEL_SHA,
            "note":"CUDA availability is checked when the worker starts; no CPU fallback."})
        }
        Err(e) => {
            json!({"configured":false,"weights_verified":false,"method":"nonlocal","error":e.to_string()})
        }
    }
}

struct Packed {
    width: usize,
    height: usize,
    positions: [(usize, usize); 4],
    black: [f32; 4],
    white: f32,
    values: Vec<f32>,
}

/// Physically crop inactive sensor borders, keeping CFA, black repeat and the
/// default crop in the new coordinate system. The rendered geometry is unchanged.
fn prepare(raw: &mut RawImage) -> Result<Packed> {
    ensure!(
        raw.cpp == 1 && raw.width > 0 && raw.height > 0,
        "NONLOCAL_UNSUPPORTED: Expected single-sample Bayer RAW"
    );
    let RawPhotometricInterpretation::Cfa(config) = &mut raw.photometric else {
        bail!("NONLOCAL_UNSUPPORTED: Expected Bayer RAW, not RGB or linear DNG");
    };
    ensure!(
        config.cfa.width == 2 && config.cfa.height == 2 && config.cfa.is_rgb(),
        "NONLOCAL_UNSUPPORTED: Only RGB Bayer CFA is supported"
    );
    ensure!(
        raw.whitelevel.0.len() == 1
            && raw.blacklevel.cpp == 1
            && raw.blacklevel.levels.len() == raw.blacklevel.width * raw.blacklevel.height
            && [1, 2].contains(&raw.blacklevel.width)
            && [1, 2].contains(&raw.blacklevel.height),
        "NONLOCAL_UNSUPPORTED: Unsupported black/white repeat pattern"
    );
    let area = raw.active_area.unwrap_or(Rect::new(
        Point::new(0, 0),
        Dim2::new(raw.width, raw.height),
    ));
    let (x, y, w, h) = (area.p.x, area.p.y, area.d.w, area.d.h);
    ensure!(
        w >= 16
            && h >= 16
            && w <= 20000
            && h <= 20000
            && w * h <= 200_000_000
            && w % 2 == 0
            && h % 2 == 0
            && x + w <= raw.width
            && y + h <= raw.height,
        "NONLOCAL_UNSUPPORTED: Expected even Bayer active dimensions between 16 and 20000 pixels"
    );
    if let Some(crop) = raw.crop_area {
        ensure!(
            crop.p.x >= x
                && crop.p.y >= y
                && crop.p.x + crop.d.w <= x + w
                && crop.p.y + crop.d.h <= y + h,
            "NONLOCAL_UNSUPPORTED: Default crop lies outside the active area"
        );
        raw.crop_area = Some(Rect::new(Point::new(crop.p.x - x, crop.p.y - y), crop.d));
    }
    let pixels = raw.data.as_f32();
    ensure!(
        pixels.len() == raw.width * raw.height,
        "NONLOCAL_UNSUPPORTED: Invalid sensor buffer"
    );
    let mut active = Vec::with_capacity(w * h);
    for row in y..y + h {
        active.extend_from_slice(&pixels[row * raw.width + x..row * raw.width + x + w]);
    }
    drop(pixels);
    config.cfa = config.cfa.shift(x, y);
    raw.camera.cfa = config.cfa.clone();
    raw.blacklevel = raw.blacklevel.shift(x, y);
    raw.width = w;
    raw.height = h;
    raw.active_area = Some(Rect::new(Point::new(0, 0), Dim2::new(w, h)));
    raw.blackareas.clear();
    let mut red = None;
    let mut blue = None;
    let mut greens = Vec::new();
    for row in 0..2 {
        for col in 0..2 {
            match config.cfa.color_at(row, col) {
                0 => red = Some((row, col)),
                1 => greens.push((row, col)),
                2 => blue = Some((row, col)),
                _ => bail!("NONLOCAL_UNSUPPORTED: Non-RGB CFA"),
            }
        }
    }
    ensure!(
        red.is_some() && blue.is_some() && greens.len() == 2,
        "NONLOCAL_UNSUPPORTED: Invalid Bayer layout"
    );
    let red = red.unwrap();
    // Checkpoint convention is R, green on the red row, B, other green.
    greens.sort_by_key(|p| p.0 != red.0);
    let positions = [red, greens[0], blue.unwrap(), greens[1]];
    let white = raw.whitelevel.0[0] as f32;
    let mut black = [0.; 4];
    let plane = w * h / 4;
    let mut values = vec![0.; w * h];
    for (c, &(dy, dx)) in positions.iter().enumerate() {
        black[c] = raw.blacklevel.levels
            [(dy % raw.blacklevel.height) * raw.blacklevel.width + dx % raw.blacklevel.width]
            .as_f32();
        ensure!(
            black[c].is_finite() && white > black[c],
            "NONLOCAL_UNSUPPORTED: Invalid RAW normalization levels"
        );
        for row in 0..h / 2 {
            for col in 0..w / 2 {
                let value =
                    (active[(row * 2 + dy) * w + col * 2 + dx] - black[c]) / (white - black[c]);
                ensure!(
                    value.is_finite(),
                    "NONLOCAL_UNSUPPORTED: Nonfinite RAW data"
                );
                values[c * plane + row * w / 2 + col] = value;
            }
        }
    }
    raw.data = RawImageData::Float(active);
    raw.bps = 32;
    Ok(Packed {
        width: w / 2,
        height: h / 2,
        positions,
        black,
        white,
        values,
    })
}

fn blend(raw: &mut RawImage, packed: &Packed, prediction: &[f32], strength: f32) -> Result<()> {
    ensure!(
        strength.is_finite() && (0.0..=1.0).contains(&strength),
        "Invalid denoise strength"
    );
    ensure!(
        prediction.len() == packed.values.len() && prediction.iter().all(|v| v.is_finite()),
        "Invalid RAW prediction"
    );
    let RawImageData::Float(pixels) = &mut raw.data else {
        bail!("Expected prepared sensor buffer")
    };
    if strength == 0. {
        return Ok(());
    }
    let plane = packed.width * packed.height;
    for (c, &(dy, dx)) in packed.positions.iter().enumerate() {
        for row in 0..packed.height {
            for col in 0..packed.width {
                let p = c * plane + row * packed.width + col;
                let index = (row * 2 + dy) * raw.width + col * 2 + dx;
                // Preserve unclipped highlights above the model's training range.
                let predicted = if packed.values[p] >= 1. {
                    pixels[index]
                } else {
                    prediction[p] * (packed.white - packed.black[c]) + packed.black[c]
                };
                pixels[index] += strength * (predicted - pixels[index]);
            }
        }
    }
    Ok(())
}

fn write_dng(path: &Path, raw: &RawImage, metadata: &RawMetadata) -> Result<()> {
    // Match the pinned rawler encoder's strip layout, but write TIFF's scalar
    // RowsPerStrip instead of its nonstandard array of per-strip row counts.
    let env_usize = |name: &str| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
    };
    let rows_per_strip = if raw.height > env_usize("RAWLER_DNG_MULTISTRIP_THRESHOLD").unwrap_or(100)
    {
        env_usize("RAWLER_DNG_ROWS_PER_STRIP")
            .unwrap_or(256)
            .min(raw.height)
    } else {
        raw.height
    };
    ensure!(rows_per_strip > 0, "Invalid DNG rows per strip");
    let mut file = File::options().write(true).create_new(true).open(path)?;
    {
        let mut buffer = BufWriter::new(&mut file);
        let mut dng = DngWriter::new(&mut buffer, DNG_VERSION_V1_4)?;
        let mut frame = dng.subframe_on_root(0);
        frame.raw_image(
            raw,
            CropMode::Best,
            DngCompression::Uncompressed,
            DngPhotometricConversion::Original,
            1,
        )?;
        frame
            .ifd_mut()
            .add_tag(TiffCommonTag::RowsPerStrip, rows_per_strip as u32);
        frame.finalize()?;
        dng.load_base_tags(raw)?;
        dng.load_metadata(metadata)?;
        dng.root_ifd_mut().add_tag(
            ExifTag::Orientation,
            metadata
                .exif
                .orientation
                .unwrap_or(raw.orientation.to_u16()),
        );
        dng.exif_ifd_mut().remove_tag(ExifTag::MakerNotes);
        dng.close()?;
        buffer.flush()?;
    }
    file.sync_all()?;
    Ok(())
}

fn regular_file(path: &Path) -> Result<()> {
    ensure!(
        fs::symlink_metadata(path)?.file_type().is_file(),
        "Expected regular Nonlocal cache file"
    );
    Ok(())
}

fn prediction(
    directory: &Path,
    request: &Value,
    request_sha: &str,
    count: usize,
) -> Result<(Vec<f32>, Value)> {
    let result_path = directory.join("result.json");
    let pixels_path = directory.join("prediction.f32");
    regular_file(&result_path)?;
    regular_file(&pixels_path)?;
    ensure!(
        fs::metadata(&result_path)?.len() < 1024 * 1024,
        "Oversized Nonlocal result manifest"
    );
    let result: Value = serde_json::from_slice(&fs::read(result_path)?)?;
    for key in [
        "protocol",
        "algorithm",
        "shape",
        "input_sha256",
        "model_sha256",
    ] {
        ensure!(
            result[key] == request[key],
            "Nonlocal prediction {key} mismatch"
        );
    }
    ensure!(
        result["request_sha256"] == request_sha,
        "Nonlocal request checksum mismatch"
    );
    ensure!(
        fs::metadata(&pixels_path)?.len() == count as u64 * 4
            && result["prediction_sha256"] == hash_file(&pixels_path)?,
        "Nonlocal prediction checksum/size mismatch"
    );
    let bytes = fs::read(pixels_path)?;
    let values: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    ensure!(
        values.iter().all(|v| v.is_finite()),
        "Nonfinite Nonlocal prediction"
    );
    Ok((values, result))
}

fn run_worker(
    python: &Path,
    checkpoint: &Path,
    directory: &Path,
    control: &DenoiseControl,
) -> Result<()> {
    let log = directory.join("stderr.log");
    let mut command = Command::new(python);
    command
        .args(["-m", "rapidraw_denoise.worker", "--directory"])
        .arg(directory)
        .arg("--checkpoint")
        .arg(checkpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(File::create(&log)?);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        // The CUDA worker must not survive an interrupted native engine.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::other("Native parent stopped"));
                }
                Ok(())
            });
        }
    }
    let mut child = command
        .spawn()
        .context("NONLOCAL_UNAVAILABLE: Could not start the CUDA worker")?;
    let stdout = child.stdout.take().unwrap();
    let (send, receive) = mpsc::sync_channel(32);
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout)
            .lines()
            .map_while(std::result::Result::ok)
        {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                let _ = send.try_send(value);
            }
        }
    });
    let start = Instant::now();
    let result = loop {
        if let Err(e) = control.check() {
            break Err(anyhow::anyhow!(e));
        }
        if start.elapsed() > Duration::from_secs(1800) {
            break Err(anyhow::anyhow!(
                "NONLOCAL_TIMEOUT: CUDA worker exceeded 30 minutes"
            ));
        }
        while let Ok(event) = receive.try_recv() {
            if let Some(fraction) = event["progress"].as_f64().filter(|v| v.is_finite()) {
                control.report(
                    0.1 + fraction.clamp(0., 1.) as f32 * 0.8,
                    "Nonlocal CUDA inference",
                );
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break Ok(()),
            Ok(Some(status)) => {
                let stderr = fs::read_to_string(&log).unwrap_or_default();
                let tail = stderr
                    .lines()
                    .rev()
                    .take(12)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n");
                break Err(anyhow::anyhow!(
                    "NONLOCAL_FAILED: Worker exited {status}: {tail}"
                ));
            }
            Err(e) => break Err(e.into()),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = reader.join();
    result
}

pub(crate) struct Output {
    pub directory: tempfile::TempDir,
    pub provenance: Value,
}
impl Output {
    pub fn path(&self) -> PathBuf {
        self.directory.path().join("result.dng")
    }
}

pub(crate) fn denoise(
    source: &Path,
    source_sha: &str,
    root: &Path,
    strength: f32,
    quality: &str,
    control: &DenoiseControl,
) -> Result<Output> {
    ensure!(
        ["balanced", "maximum"].contains(&quality),
        "Invalid Nonlocal quality"
    );
    ensure!(
        strength.is_finite() && (0.0..=1.0).contains(&strength),
        "Invalid Nonlocal strength"
    );
    control.check().map_err(anyhow::Error::msg)?;
    control.report(0., "Decoding Bayer RAW");
    let bytes = fs::read(source)?;
    ensure!(
        hex::encode(Sha256::digest(&bytes)) == source_sha,
        "SOURCE_CHANGED: RAW source checksum mismatch"
    );
    let input = RawSource::new_from_slice(&bytes);
    let decoder = rawler::get_decoder(&input)?;
    let mut raw = decoder.raw_image(&input, &RawDecodeParams::default(), false)?;
    let metadata = decoder.raw_metadata(&input, &RawDecodeParams::default())?;
    drop(decoder);
    drop(input);
    drop(bytes);
    let packed = prepare(&mut raw)?;
    let root_path = root.canonicalize()?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    if let Some(disk) = disks
        .iter()
        .filter(|d| root_path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
    {
        let needed = 20 * 1024_u64.pow(3) + packed.values.len() as u64 * 4 * 7;
        ensure!(
            disk.available_space() >= needed,
            "NONLOCAL_STORAGE: Need 20 GiB reserve plus RAW job working space"
        );
    }
    let cache = root.join("nonlocal-cache");
    fs::create_dir_all(&cache)?;
    ensure!(
        fs::symlink_metadata(&cache)?.file_type().is_dir(),
        "Nonlocal cache must be a real directory"
    );
    let directory = tempfile::Builder::new()
        .prefix("work-")
        .tempdir_in(&cache)?;
    let mut provenance = json!({"algorithm":ALGORITHM,"model_sha256":MODEL_SHA,"quality":quality,"cache_hit":false,
        "source_sha256":source_sha,"packed_shape":[4,packed.height,packed.width],"output":"float32-bayer-dng",
        "normalization":"per-CFA black/white; signed noise estimation; unclipped highlights preserved"});
    if strength > 0. {
        let (python, checkpoint) = configuration()?;
        let input_path = directory.path().join("input.f32");
        let mut writer = BufWriter::new(File::create(&input_path)?);
        for value in &packed.values {
            writer.write_all(&value.to_le_bytes())?;
        }
        writer.flush()?;
        drop(writer);
        let request = json!({"protocol":1,"algorithm":ALGORITHM,"model_sha256":MODEL_SHA,
            "input_sha256":hash_file(&input_path)?,"source_sha256":source_sha,
            "shape":[4,packed.height,packed.width],"tile":320,"halo":64,"ensemble":if quality=="maximum"{4}else{1}});
        let request_bytes = serde_json::to_vec(&request)?;
        let request_sha = hex::encode(Sha256::digest(&request_bytes));
        let cached = cache.join(&request_sha);
        let (values, receipt) = if cached.exists() {
            ensure!(
                fs::symlink_metadata(&cached)?.file_type().is_dir(),
                "Nonlocal cache entry must be a real directory"
            );
            provenance["cache_hit"] = json!(true);
            prediction(&cached, &request, &request_sha, packed.values.len()).context(
                "NONLOCAL_CACHE_INVALID: Remove this corrupt cache entry before retrying",
            )?
        } else {
            fs::write(directory.path().join("request.json"), request_bytes)?;
            control.check().map_err(anyhow::Error::msg)?;
            run_worker(&python, &checkpoint, directory.path(), control)?;
            let prediction = prediction(
                directory.path(),
                &request,
                &request_sha,
                packed.values.len(),
            )?;
            control.check().map_err(anyhow::Error::msg)?;
            let staging = tempfile::Builder::new()
                .prefix("cache-")
                .tempdir_in(&cache)?;
            for name in ["result.json", "prediction.f32"] {
                crate::storage_copy::copy_new(
                    &directory.path().join(name),
                    &staging.path().join(name),
                )?;
            }
            fs::rename(staging.path(), &cached)?;
            prediction
        };
        provenance["worker"] = receipt;
        provenance["cache_key"] = json!(request_sha);
        blend(&mut raw, &packed, &values, strength)?;
    }
    control.check().map_err(anyhow::Error::msg)?;
    control.report(0.95, "Writing Bayer DNG");
    write_dng(&directory.path().join("result.dng"), &raw, &metadata)?;
    control.check().map_err(anyhow::Error::msg)?;
    Ok(Output {
        directory,
        provenance,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rawler::{
        CFA,
        decoders::Camera,
        exif::Exif,
        pixarray::PixU16,
        rawimage::{BlackLevel, CFAConfig, WhiteLevel},
    };
    fn fixture(pattern: &str, offset: usize) -> RawImage {
        let mut camera = Camera::new();
        camera.cfa = CFA::new(pattern);
        let photometric = RawPhotometricInterpretation::Cfa(CFAConfig::new_from_camera(&camera));
        let mut raw = RawImage::new(
            camera,
            PixU16::new_with(
                (0..24 * 24).map(|i| (i % 23 + 800) as u16).collect(),
                24,
                24,
            ),
            1,
            [2., 1., 1.5, 1.],
            photometric,
            Some(BlackLevel::new(&[100_u16, 200, 300, 400], 2, 2, 1)),
            Some(WhiteLevel::new(vec![4095])),
            false,
        );
        raw.active_area = Some(Rect::new(Point::new(offset, offset), Dim2::new(20, 20)));
        raw.crop_area = Some(Rect::new(
            Point::new(offset + 2, offset + 2),
            Dim2::new(16, 16),
        ));
        raw
    }
    #[test]
    fn bayer_phases_signed_normalization_and_strength() {
        for pattern in ["RGGB", "BGGR", "GRBG", "GBRG"] {
            for offset in [0, 1] {
                let mut raw = fixture(pattern, offset);
                let original = raw.data.as_f32().to_vec();
                let packed = prepare(&mut raw).unwrap();
                assert_eq!((packed.width, packed.height), (10, 10));
                assert_eq!(raw.crop_area.unwrap().p, Point::new(2, 2));
                let RawPhotometricInterpretation::Cfa(config) = &raw.photometric else {
                    panic!()
                };
                for (c, (dy, dx)) in packed.positions.iter().enumerate() {
                    assert_eq!(config.cfa.color_at(*dy, *dx), [0, 1, 2, 1][c]);
                }
                assert_eq!(packed.positions[0].0, packed.positions[1].0);
                for y in 0..20 {
                    for x in 0..20 {
                        assert_eq!(
                            raw.data.as_f32()[y * 20 + x],
                            original[(y + offset) * 24 + x + offset]
                        );
                    }
                }
                let before = raw.data.as_f32().to_vec();
                blend(&mut raw, &packed, &packed.values, 1.).unwrap();
                assert!(
                    raw.data
                        .as_f32()
                        .iter()
                        .zip(&before)
                        .all(|(a, b)| (a - b).abs() < 0.001)
                );
                let prediction = vec![0.; 400];
                blend(&mut raw, &packed, &prediction, 0.).unwrap();
                assert!(
                    raw.data
                        .as_f32()
                        .iter()
                        .zip(&before)
                        .all(|(a, b)| (a - b).abs() < 0.001)
                );
                blend(&mut raw, &packed, &prediction, 0.5).unwrap();
                for (c, (dy, dx)) in packed.positions.iter().enumerate() {
                    let index = dy * 20 + dx;
                    assert!(
                        (raw.data.as_f32()[index] - (before[index] + packed.black[c]) * 0.5).abs()
                            < 0.001
                    );
                }
                assert!(blend(&mut raw, &packed, &[f32::NAN; 400], 1.).is_err());
                assert!(blend(&mut raw, &packed, &[0.; 399], 1.).is_err());
            }
        }
        let mut raw = fixture("RGGB", 0);
        raw.data = RawImageData::Float(vec![0.; 24 * 24]);
        assert!(prepare(&mut raw).unwrap().values.iter().all(|v| *v < 0.));
    }
    #[test]
    fn float_bayer_dng_roundtrip_preserves_counts_and_metadata() {
        for pattern in ["RGGB", "BGGR", "GRBG", "GBRG"] {
            for offset in [0, 1] {
                let mut raw = fixture(pattern, offset);
                prepare(&mut raw).unwrap();
                let metadata = RawMetadata {
                    exif: Exif {
                        orientation: Some(6),
                        ..Default::default()
                    },
                    make: "Test".into(),
                    model: "Bayer".into(),
                    lens: None,
                    unique_image_id: None,
                    rating: None,
                };
                let root = tempfile::tempdir().unwrap();
                let output = root.path().join("test.dng");
                write_dng(&output, &raw, &metadata).unwrap();
                let bytes = fs::read(output).unwrap();
                let source = RawSource::new_from_slice(&bytes);
                let decoder = rawler::get_decoder(&source).unwrap();
                let reloaded = decoder
                    .raw_image(&source, &RawDecodeParams::default(), false)
                    .unwrap();
                assert_eq!(reloaded.data.as_f32(), raw.data.as_f32());
                assert_eq!(reloaded.photometric, raw.photometric);
                assert_eq!(reloaded.blacklevel, raw.blacklevel);
                assert_eq!(reloaded.whitelevel, raw.whitelevel);
                assert_eq!(reloaded.crop_area, raw.crop_area);
                assert_eq!(
                    decoder
                        .raw_metadata(&source, &RawDecodeParams::default())
                        .unwrap()
                        .exif
                        .orientation,
                    Some(6)
                );
            }
        }
    }
    #[test]
    fn prediction_cache_rejects_corruption_and_wrong_provenance() {
        let root = tempfile::tempdir().unwrap();
        let request = json!({"protocol":1,"algorithm":ALGORITHM,"shape":[4,8,8],"input_sha256":"input","model_sha256":MODEL_SHA});
        let pixels = root.path().join("prediction.f32");
        fs::write(&pixels, vec![0_u8; 4 * 8 * 8 * 4]).unwrap();
        let receipt = json!({"protocol":1,"algorithm":ALGORITHM,"shape":[4,8,8],"input_sha256":"input","model_sha256":MODEL_SHA,
            "request_sha256":"request","prediction_sha256":hash_file(&pixels).unwrap()});
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert!(prediction(root.path(), &request, "request", 256).is_ok());
        assert!(prediction(root.path(), &request, "wrong", 256).is_err());
        fs::write(&pixels, vec![1_u8; 4 * 8 * 8 * 4]).unwrap();
        assert!(prediction(root.path(), &request, "request", 256).is_err());
        let bytes: Vec<_> = (0..256).flat_map(|_| f32::NAN.to_le_bytes()).collect();
        fs::write(&pixels, bytes).unwrap();
        let mut receipt = receipt;
        receipt["prediction_sha256"] = json!(hash_file(&pixels).unwrap());
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert!(prediction(root.path(), &request, "request", 256).is_err());
    }
    #[test]
    fn values_above_white_survive_the_prediction_blend() {
        let mut raw = fixture("RGGB", 0);
        raw.data = RawImageData::Float(vec![5000.; 24 * 24]);
        let packed = prepare(&mut raw).unwrap();
        blend(&mut raw, &packed, &vec![0.; packed.values.len()], 1.).unwrap();
        assert!(raw.data.as_f32().iter().all(|v| *v == 5000.));
    }
    #[test]
    fn multistrip_dng_has_standard_scalar_strip_height() {
        use rawler::formats::tiff::{GenericTiffReader, reader::TiffReader};
        let mut raw = fixture("RGGB", 0);
        prepare(&mut raw).unwrap();
        raw.height = 600;
        raw.data = RawImageData::Float(
            (0..raw.width * raw.height)
                .map(|i| i as f32 * 0.125)
                .collect(),
        );
        raw.active_area = Some(Rect::new(
            Point::new(0, 0),
            Dim2::new(raw.width, raw.height),
        ));
        raw.crop_area = raw.active_area;
        let metadata = RawMetadata {
            exif: Exif::default(),
            make: "Test".into(),
            model: "Bayer".into(),
            lens: None,
            unique_image_id: None,
            rating: None,
        };
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("multi.dng");
        write_dng(&path, &raw, &metadata).unwrap();
        let bytes = fs::read(path).unwrap();
        let tiff = GenericTiffReader::new_with_buffer(&bytes, 0, 0, None).unwrap();
        let rows = tiff.get_entry(TiffCommonTag::RowsPerStrip).unwrap();
        assert_eq!(rows.count(), 1);
        let rows = rows.force_usize(0);
        assert!(rows > 0);
        let strips = tiff.get_entry(TiffCommonTag::StripOffsets).unwrap().count() as usize;
        assert_eq!(strips, raw.height.div_ceil(rows));
        let source = RawSource::new_from_slice(&bytes);
        let decoder = rawler::get_decoder(&source).unwrap();
        let reloaded = decoder
            .raw_image(&source, &RawDecodeParams::default(), false)
            .unwrap();
        assert_eq!(raw.data.as_f32(), reloaded.data.as_f32());
    }
    #[test]
    #[ignore = "Requires RAPIDRAW_TEST_RAW and optional RAPIDRAW_TEST_DNG on a host with a real Bayer fixture"]
    fn real_raw_identity_uses_native_developer() {
        let path = PathBuf::from(std::env::var_os("RAPIDRAW_TEST_RAW").unwrap());
        let bytes = fs::read(&path).unwrap();
        let source = RawSource::new_from_slice(&bytes);
        let decoder = rawler::get_decoder(&source).unwrap();
        let mut raw = decoder
            .raw_image(&source, &RawDecodeParams::default(), false)
            .unwrap();
        let metadata = decoder
            .raw_metadata(&source, &RawDecodeParams::default())
            .unwrap();
        eprintln!(
            "original geometry {}x{} active {:?} crop {:?}, black {:?}, WB {:?}",
            raw.width, raw.height, raw.active_area, raw.crop_area, raw.blacklevel, raw.wb_coeffs
        );
        prepare(&mut raw).unwrap();
        let root = tempfile::tempdir().unwrap();
        let output = std::env::var_os("RAPIDRAW_TEST_DNG")
            .map(PathBuf::from)
            .unwrap_or(root.path().join("identity.dng"));
        write_dng(&output, &raw, &metadata).unwrap();
        let a = crate::raw_processing::develop_raw_image(&bytes, false, 3., "auto".into(), None)
            .unwrap()
            .to_rgb32f();
        let b = crate::raw_processing::develop_raw_image(
            &fs::read(&output).unwrap(),
            false,
            3.,
            "auto".into(),
            None,
        )
        .unwrap()
        .to_rgb32f();
        assert_eq!(a.dimensions(), b.dimensions());
        let mut sum = 0_f64;
        let mut max = 0_f32;
        for (a, b) in a.as_raw().iter().zip(b.as_raw()) {
            let d = (a - b).abs();
            sum += d as f64;
            max = max.max(d);
        }
        let mean = sum / a.as_raw().len() as f64;
        eprintln!(
            "Native DNG identity: dimensions {:?}, mean absolute difference {mean}, max {max}",
            a.dimensions()
        );
        assert!(
            mean < 0.00002 && max < 0.002,
            "DNG transport changed native rendered pixels"
        );
    }
}
