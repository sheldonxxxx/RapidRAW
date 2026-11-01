use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

fn verify_sha256(path: &Path, expected_hash: &str) -> Result<bool, io::Error> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let hash_bytes = hasher.finalize();
    let calculated_hash = hex::encode(hash_bytes);
    Ok(calculated_hash == expected_hash)
}

fn download_and_verify(
    url: &str,
    dest_path: &Path,
    expected_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let temp_filename = dest_path.file_name().unwrap();
    let temp_path = out_dir.join(temp_filename);

    println!(
        "cargo:warning=Downloading to temporary path: {:?}",
        temp_path
    );
    let mut response = reqwest::blocking::get(url)?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response
            .text()
            .unwrap_or_else(|_| "Could not read error body".to_string());
        return Err(format!("Download failed with status {}: {}", status, error_body).into());
    }

    let mut temp_file = fs::File::create(&temp_path)?;
    response.copy_to(&mut temp_file)?;
    println!("cargo:warning=Download complete. Verifying file integrity...");

    temp_file.sync_all()?;
    drop(temp_file);
    match verify_sha256(&temp_path, expected_hash) {
        Ok(true) => {
            fs::copy(&temp_path, dest_path)?;
            fs::remove_file(&temp_path)?;
            println!(
                "cargo:warning=Successfully downloaded and verified {:?}.",
                dest_path
            );
            Ok(())
        }
        Ok(false) => {
            fs::remove_file(&temp_path)?;
            Err("Verification failed! The downloaded file is corrupt.".into())
        }
        Err(e) => {
            fs::remove_file(&temp_path).ok();
            Err(format!("Could not verify file after download: {}", e).into())
        }
    }
}

fn install_apple_silicon_runtime(manifest_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    const URL: &str = "https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-osx-arm64-1.30.0.tgz";
    const ARCHIVE_HASH: &str = "6ebb5062a934537c352937821f9fe9718e7de1a2db1122a93dd363ffd53a7012";
    // Exact regular entries only; never unpack the archive into application resources.
    let files = [
        (
            "lib/libonnxruntime.dylib",
            "libonnxruntime.dylib",
            "bffaa6ef856dba2c26f09c7c0e7018fd1562625f3485292c7ad28b83748c6879",
        ),
        (
            "LICENSE",
            "licenses/ONNX-Runtime-MIT.txt",
            "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c",
        ),
        (
            "ThirdPartyNotices.txt",
            "licenses/ONNX-Runtime-ThirdPartyNotices.txt",
            "143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3",
        ),
    ];
    let resources = manifest_dir.join("resources");
    if files
        .iter()
        .all(|(_, name, hash)| verify_sha256(&resources.join(name), hash).unwrap_or(false))
    {
        println!(
            "cargo:warning=Verified Apple Silicon ONNX Runtime 1.30.0 and notices; using cached files."
        );
        return Ok(());
    }
    let staging = PathBuf::from(env::var("OUT_DIR")?).join("onnx-runtime-1.30.0");
    fs::create_dir_all(&staging)?;
    let archive_path = staging.join("runtime.tgz");
    if !verify_sha256(&archive_path, ARCHIVE_HASH).unwrap_or(false) {
        println!("cargo:warning=Downloading official Apple Silicon ONNX Runtime 1.30.0.");
        let mut response = reqwest::blocking::get(URL)?.error_for_status()?;
        let mut archive_file = fs::File::create(&archive_path)?;
        response.copy_to(&mut archive_file)?;
        archive_file.sync_all()?;
        if !verify_sha256(&archive_path, ARCHIVE_HASH)? {
            fs::remove_file(&archive_path)?;
            return Err("ONNX Runtime archive SHA-256 does not match the pinned release".into());
        }
    }
    let compressed = flate2::read::GzDecoder::new(fs::File::open(&archive_path)?);
    let mut archive = tar::Archive::new(compressed);
    let mut found = [false; 3];
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let path = path.strip_prefix(".").unwrap_or(&path);
        for (index, (source, _, hash)) in files.iter().enumerate() {
            if path == Path::new("onnxruntime-osx-arm64-1.30.0").join(source) {
                if found[index] || !entry.header().entry_type().is_file() {
                    return Err(
                        "ONNX Runtime archive contains an invalid or repeated required entry"
                            .into(),
                    );
                }
                let output = staging.join(index.to_string());
                entry.unpack(&output)?;
                if !verify_sha256(&output, hash)? {
                    return Err(format!(
                        "ONNX Runtime extracted file failed SHA-256 verification: {source}"
                    )
                    .into());
                }
                found[index] = true;
            }
        }
    }
    if found.iter().any(|present| !present) {
        return Err("ONNX Runtime archive is missing a required library or license".into());
    }
    // Verify every input before replacing any resource. Rename each verified
    // sibling into place so failed downloads leave the existing library intact.
    for (index, (_, name, _)) in files.iter().enumerate().rev() {
        let destination = resources.join(name);
        fs::create_dir_all(destination.parent().unwrap())?;
        let temporary = destination.with_extension(format!("{}.tmp", std::process::id()));
        fs::copy(staging.join(index.to_string()), &temporary)?;
        fs::File::open(&temporary)?.sync_all()?;
        fs::rename(temporary, destination)?;
    }
    println!(
        "cargo:warning=Installed verified Apple Silicon ONNX Runtime 1.30.0 with license notices."
    );
    Ok(())
}

/// Compile the macOS-only direct CoreML bridge and link the required
/// system frameworks. Called for macOS targets only; other platforms skip
/// it entirely (the Rust side gates all CoreML FFI on `target_os = "macos"`).
fn build_coreml_bridge() {
    cc::Build::new()
        .file("src/nonlocal_coreml_bridge.m")
        .flag("-fobjc-arc")
        .compile("nlx_coreml_bridge");
    println!("cargo:rustc-link-lib=framework=CoreML");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rerun-if-changed=src/nonlocal_coreml_bridge.m");
}

fn runtime_libraries(
    target_os: &str,
    target_arch: &str,
) -> Vec<(&'static str, &'static str, &'static str)> {
    match (target_os, target_arch) {
        ("windows", "x86_64") => vec![
            (
                "onnxruntime-directml-windows-x86_64.dll",
                "onnxruntime.dll",
                "95366724919f4e95ecc60010912ed538ad9804b6683fbd0aad389749102834b9",
            ),
            (
                "directml-windows-x86_64.dll",
                "DirectML.dll",
                "9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1",
            ),
        ],
        ("windows", "aarch64") => vec![
            (
                "onnxruntime-directml-windows-aarch64.dll",
                "onnxruntime.dll",
                "c544001fbb76c7217fce76e9c24dada4a35d263b7ae3c0024474d9d7323a888f",
            ),
            (
                "directml-windows-aarch64.dll",
                "DirectML.dll",
                "77b0db83ff903f2323f5caf538499d75af6038bbea23b7959f7d232d9a4ab9d4",
            ),
        ],
        ("linux", "x86_64") => vec![(
            "libonnxruntime-linux-x86_64.so",
            "libonnxruntime.so",
            "3da6146e14e7b8aaec625dde11d6114c7457c87a5f93d744897da8781e35c673",
        )],
        ("linux", "aarch64") => vec![(
            "libonnxruntime-linux-aarch64.so",
            "libonnxruntime.so",
            "0afd69a0ae38c5099fd0e8604dda398ac43dee67cd9c6394b5142b19e82528de",
        )],
        ("macos", "x86_64") => vec![(
            "libonnxruntime-macos-x86_64.dylib",
            "libonnxruntime.dylib",
            "283e595e61cf65df7a6b1d59a1616cbd35c8b6399dd90d799d99b71a3ff83160",
        )],
        ("macos", "aarch64") => vec![(
            "libonnxruntime-macos-aarch64.dylib",
            "libonnxruntime.dylib",
            "2b885992d3d6fa4130d39ec84a80d7504ff52750027c547bb22c86165f19406a",
        )],
        ("android", "aarch64") => vec![(
            "libonnxruntime-android-arm64-v8a.so",
            "libonnxruntime.so",
            "999ecfdb5b5a13e4097487773b6d71ce8a075408a237daab072e8f5e817bd78e",
        )],
        _ => panic!("Unsupported target: {}-{}", target_os, target_arch),
    }
}

fn copy_and_verify(
    source_path: &Path,
    dest_path: &Path,
    expected_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if !verify_sha256(source_path, expected_hash)? {
        return Err(format!("Local file {:?} has an incorrect hash.", source_path).into());
    }
    fs::copy(source_path, dest_path)?;
    println!(
        "cargo:warning=Copied and verified {:?} from {:?}.",
        dest_path, source_path
    );
    Ok(())
}

fn ensure_runtime_library(
    dest_dir: &Path,
    download_filename: &str,
    lib_name: &str,
    expected_hash: &str,
) -> PathBuf {
    let dest_path = dest_dir.join(lib_name);

    if dest_path.exists() {
        match verify_sha256(&dest_path, expected_hash) {
            Ok(true) => {
                println!(
                    "cargo:warning={} already exists and is valid. Skipping download.",
                    lib_name
                );
                return dest_path;
            }
            Ok(false) => {
                println!(
                    "cargo:warning=File {:?} exists but has incorrect hash. Deleting and re-downloading.",
                    dest_path
                );
            }
            Err(e) => {
                println!(
                    "cargo:warning=Could not verify file {:?}: {}. Re-downloading.",
                    dest_path, e
                );
            }
        }
    }

    let local_path = env::var_os("RAPIDRAW_RUNTIME_DIR")
        .map(|dir| PathBuf::from(dir).join(download_filename))
        .filter(|path| path.exists());

    let result = if let Some(local_path) = local_path {
        copy_and_verify(&local_path, &dest_path, expected_hash)
    } else {
        println!("cargo:warning=Downloading {}...", download_filename);
        let base_url =
            "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/onnxruntimes-v1.22.0/";
        let download_url = format!("{}{}?download=true", base_url, download_filename);
        println!("cargo:warning=URL: {}", download_url);
        download_and_verify(&download_url, &dest_path, expected_hash)
    };

    if let Err(e) = result {
        panic!("Failed to download and verify {}: {}", lib_name, e);
    }

    dest_path
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();

    if target_os == "macos" {
        build_coreml_bridge();
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    if target_os == "macos" && target_arch == "aarch64" {
        install_apple_silicon_runtime(&manifest_dir)
            .expect("Failed to install the Apple Silicon ONNX Runtime");
        println!("cargo:rerun-if-changed=build.rs");
        println!("cargo:rerun-if-changed=resources/libonnxruntime.dylib");
        println!("cargo:rerun-if-changed=resources/licenses/ONNX-Runtime-MIT.txt");
        println!("cargo:rerun-if-changed=resources/licenses/ONNX-Runtime-ThirdPartyNotices.txt");
        tauri_build::build();
        return;
    }

    let dest_dir = if target_os == "android" {
        manifest_dir.join("libs").join("arm64-v8a")
    } else {
        manifest_dir.join("resources")
    };

    fs::create_dir_all(&dest_dir).unwrap();

    let lib_paths: Vec<PathBuf> = runtime_libraries(&target_os, &target_arch)
        .into_iter()
        .map(|(download_filename, lib_name, expected_hash)| {
            ensure_runtime_library(&dest_dir, download_filename, lib_name, expected_hash)
        })
        .collect();

    if target_os == "android" {
        let jni_libs_dir = manifest_dir.join("gen/android/app/src/main/jniLibs/arm64-v8a");
        fs::create_dir_all(&jni_libs_dir).unwrap();
        for lib_path in &lib_paths {
            fs::copy(lib_path, jni_libs_dir.join(lib_path.file_name().unwrap())).unwrap();
        }

        println!("cargo:rustc-env=ORT_LIB_LOCATION={}", dest_dir.display());
        println!("cargo:rustc-env=ORT_STRATEGY=manual");
        println!("cargo:rustc-link-search=native={}", dest_dir.display());
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RAPIDRAW_RUNTIME_DIR");

    tauri_build::build()
}
