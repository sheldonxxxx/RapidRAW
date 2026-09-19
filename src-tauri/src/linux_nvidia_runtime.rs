//! Linux x86_64 NVIDIA runtime auto-activation planning.
//!
//! The optional CUDA user-space pack is distributed as an independently
//! versioned `.tgz` (see `packaging/linux-nvidia-runtime.release.json`)
//! and is never embedded in the normal CPU packages. Before any Tauri or
//! ONNX Runtime initialization, [`maybe_activate`] discovers an installed
//! pack, pins its `runtime.json` identity against the tracked release
//! metadata, applies provider defaults, and re-execs the process with the
//! pack library path so CUDA dependencies resolve to pack files only.
//!
//! All decisions live in the pure [`plan`] function over an explicit
//! [`EnvSnapshot`]; the real process environment, executable path and
//! `exec` call stay at the thin [`maybe_activate`] boundary so the whole
//! matrix is unit-testable without spawning or replacing the test process.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub(crate) const RUNTIME_ENV: &str = "RAPIDRAW_NVIDIA_RUNTIME";
pub(crate) const ACTIVE_MARKER: &str = "RAPIDRAW_NVIDIA_RUNTIME_ACTIVE";
pub(crate) const ONNX_ENV: &str = "RAPIDRAW_ONNX_PROVIDER";
pub(crate) const NONLOCAL_ENV: &str = "RAPIDRAW_NONLOCAL_PROVIDER";
pub(crate) const ORT_ENV: &str = "ORT_DYLIB_PATH";
pub(crate) const LD_ENV: &str = "LD_LIBRARY_PATH";
pub(crate) const APPIMAGE_ENV: &str = "APPIMAGE";

const RELEASE_METADATA: &str = include_str!("../../packaging/linux-nvidia-runtime.release.json");
pub(crate) const RELEASE_SCHEMA: &str = "rapidraw-linux-nvidia-runtime-release-v1";

/// Tracked compatibility contract for the independently versioned runtime.
#[derive(Clone, Debug, serde::Deserialize)]
pub(crate) struct ReleasePin {
    #[serde(rename = "$schema")]
    pub(crate) schema: String,
    pub(crate) runtime_tag: String,
    pub(crate) pack_name: String,
    pub(crate) manifest_schema: String,
    pub(crate) asset: String,
    pub(crate) asset_sha256: String,
    pub(crate) asset_size: u64,
    pub(crate) runtime_json_sha256: String,
    pub(crate) os: String,
    pub(crate) arch: String,
}

pub(crate) fn parse_release_pin(text: &str) -> anyhow::Result<ReleasePin> {
    let pin: ReleasePin = serde_json::from_str(text)?;
    if pin.schema != RELEASE_SCHEMA {
        anyhow::bail!(
            "tracked NVIDIA runtime release metadata has unsupported schema {:?}",
            pin.schema
        );
    }
    Ok(pin)
}

pub(crate) fn load_release_pin() -> anyhow::Result<ReleasePin> {
    let pin = parse_release_pin(RELEASE_METADATA)?;
    if pin.asset.is_empty() || pin.asset_sha256.len() != 64 || pin.asset_size == 0 {
        anyhow::bail!("tracked NVIDIA runtime release metadata has no usable asset");
    }
    Ok(pin)
}

/// Explicit snapshot of the process inputs [`plan`] may read. Constructed
/// once from the real environment at startup; tests build it directly.
#[derive(Clone, Debug, Default)]
pub(crate) struct EnvSnapshot {
    pub(crate) runtime_override: Option<String>,
    pub(crate) active_marker: Option<String>,
    pub(crate) onnx_provider: Option<String>,
    pub(crate) nonlocal_provider: Option<String>,
    pub(crate) ort_dylib_path: Option<String>,
    pub(crate) ld_library_path: Option<String>,
    pub(crate) appimage: Option<String>,
    pub(crate) xdg_data_home: Option<String>,
    pub(crate) home: Option<String>,
}

impl EnvSnapshot {
    pub(crate) fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Self {
            runtime_override: var(RUNTIME_ENV),
            active_marker: var(ACTIVE_MARKER),
            onnx_provider: var(ONNX_ENV),
            nonlocal_provider: var(NONLOCAL_ENV),
            ort_dylib_path: var(ORT_ENV),
            ld_library_path: var(LD_ENV),
            appimage: var(APPIMAGE_ENV),
            xdg_data_home: var("XDG_DATA_HOME"),
            home: var("HOME"),
        }
    }
}

/// A pack directory that passed every identity check.
#[derive(Clone, Debug)]
pub(crate) struct ValidatedPack {
    /// Canonical pack root (symlinks such as `current` fully resolved).
    pub(crate) root: PathBuf,
    /// Canonical `lib/libonnxruntime.so`, resolved inside [`root`](Self::root).
    pub(crate) ort_library: PathBuf,
}

/// Outcome of [`plan`]. `Inactive` continues normal CPU startup; `Activate`
/// carries everything the re-exec needs.
#[derive(Clone, Debug)]
pub(crate) enum Plan {
    Inactive { warning: Option<String> },
    Activate(Activation),
}

#[derive(Clone, Debug)]
pub(crate) struct Activation {
    pub(crate) pack_root: PathBuf,
    pub(crate) ort_library: PathBuf,
    /// Exact environment for the re-execed child (no parent mutation).
    pub(crate) child_env: Vec<(String, String)>,
    /// Re-exec target: the original AppImage path when valid, else the
    /// current executable.
    pub(crate) target: PathBuf,
}

/// Which provider strings were resolved for the activation decision.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ResolvedProviders {
    pub(crate) onnx: String,
    pub(crate) nonlocal: String,
}

fn default_current_path(env: &EnvSnapshot) -> Option<PathBuf> {
    let base = match env.xdg_data_home.as_deref().filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => env
            .home
            .as_deref()
            .filter(|v| !v.is_empty())
            .map(|home| Path::new(home).join(".local").join("share"))?,
    };
    Some(base.join("rapidraw").join("nvidia-runtime").join("current"))
}

/// Resolve the candidate pack path without touching its contents.
/// Returns `(path, explicit)`; `None` means no pack is configured.
fn candidate_path(env: &EnvSnapshot) -> Result<Option<(PathBuf, bool)>, String> {
    match env.runtime_override.as_deref() {
        Some("off") => Ok(None),
        Some(path) => {
            let candidate = PathBuf::from(path);
            if !candidate.is_absolute() {
                return Err(format!(
                    "NVIDIA_RUNTIME_INVALID: {RUNTIME_ENV} must be \"off\" or an absolute pack path, got {path:?}"
                ));
            }
            Ok(Some((candidate, true)))
        }
        None => Ok(default_current_path(env).map(|path| (path, false))),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn validate_pack(root: &Path, pin: &ReleasePin) -> Result<ValidatedPack, String> {
    let canonical = std::fs::canonicalize(root).map_err(|error| {
        format!(
            "NVIDIA_RUNTIME_INVALID: cannot resolve pack path {}: {error}",
            root.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "NVIDIA_RUNTIME_INVALID: pack path is not a directory: {}",
            canonical.display()
        ));
    }
    let manifest_path = canonical.join("runtime.json");
    let bytes = std::fs::read(&manifest_path).map_err(|error| {
        format!(
            "NVIDIA_RUNTIME_INVALID: cannot read {}: {error}",
            manifest_path.display()
        )
    })?;
    if sha256_hex(&bytes) != pin.runtime_json_sha256 {
        return Err(format!(
            "NVIDIA_RUNTIME_MISMATCH: {} does not match release {}",
            manifest_path.display(),
            pin.runtime_tag
        ));
    }
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "NVIDIA_RUNTIME_INVALID: {} is not valid JSON: {error}",
            manifest_path.display()
        )
    })?;
    let field = |name: &str| {
        manifest
            .get(name)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                format!(
                    "NVIDIA_RUNTIME_INVALID: {} lacks {name:?}",
                    manifest_path.display()
                )
            })
    };
    if field("manifest_schema")? != pin.manifest_schema {
        return Err(format!(
            "NVIDIA_RUNTIME_MISMATCH: manifest schema is not {}",
            pin.manifest_schema
        ));
    }
    if field("pack")? != pin.pack_name {
        return Err(format!(
            "NVIDIA_RUNTIME_MISMATCH: pack is not {}",
            pin.pack_name
        ));
    }
    if field("os")? != pin.os || field("arch")? != pin.arch {
        return Err(format!(
            "NVIDIA_RUNTIME_MISMATCH: pack is not {}/{}",
            pin.os, pin.arch
        ));
    }
    let ort_library = canonical.join("lib").join("libonnxruntime.so");
    if !ort_library.is_file() {
        return Err(format!(
            "NVIDIA_RUNTIME_INVALID: {} is missing",
            ort_library.display()
        ));
    }
    let resolved = std::fs::canonicalize(&ort_library).map_err(|error| {
        format!(
            "NVIDIA_RUNTIME_INVALID: cannot resolve {}: {error}",
            ort_library.display()
        )
    })?;
    if !resolved.starts_with(&canonical) {
        return Err(format!(
            "NVIDIA_RUNTIME_INVALID: {} escapes the pack root",
            ort_library.display()
        ));
    }
    Ok(ValidatedPack {
        root: canonical,
        ort_library: resolved,
    })
}

/// Resolve provider values without mutating the process. An unset ONNX
/// provider defaults to CUDA exactly when a valid pack was discovered
/// (installing the pack is the explicit GPU opt-in); an unset Nonlocal
/// provider follows the resolved ONNX value. Explicit values are preserved
/// verbatim, including an explicit `cpu` that keeps its process on CPU.
pub(crate) fn resolve_providers(
    onnx: Option<&str>,
    nonlocal: Option<&str>,
    pack_valid: bool,
) -> ResolvedProviders {
    let onnx = onnx
        .map(str::to_owned)
        .unwrap_or_else(|| pack_valid.then_some("cuda").unwrap_or("cpu").to_owned());
    let nonlocal = nonlocal.map(str::to_owned).unwrap_or_else(|| onnx.clone());
    ResolvedProviders { onnx, nonlocal }
}

fn provider_needs_cuda(providers: &ResolvedProviders) -> bool {
    // `auto` attempts CUDA first, so it needs the pack libraries too.
    providers.onnx == "cuda" || providers.onnx == "auto" || providers.nonlocal == "cuda"
}

fn explicit_cuda_requested(env: &EnvSnapshot) -> bool {
    env.onnx_provider.as_deref() == Some("cuda") || env.nonlocal_provider.as_deref() == Some("cuda")
}

/// Pure activation planning. `linux_x86_64` and `current_exe` are explicit
/// parameters so every branch is testable on any host; no process-global
/// state is read or written and the caller performs the actual `exec`.
/// Precedence: `off` disables; an explicit pack path always wins; otherwise
/// a caller-supplied `ORT_DYLIB_PATH` means the operator owns the runtime
/// (no discovery, no re-exec, no preemptive CUDA rejection); only then is
/// the XDG `current` pack auto-discovered.
pub(crate) fn plan(
    env: &EnvSnapshot,
    linux_x86_64: bool,
    current_exe: &Path,
    pin: &ReleasePin,
) -> Result<Plan, String> {
    if !linux_x86_64 {
        return Ok(Plan::Inactive { warning: None });
    }
    if env.runtime_override.as_deref() == Some("off") {
        return Ok(Plan::Inactive { warning: None });
    }
    let candidate = candidate_path(env)?;
    // A matching ACTIVE marker means this process already is the re-execed
    // child; anything else alongside a marker is a contradictory setup.
    if let Some(marker) = env.active_marker.as_deref() {
        match &candidate {
            Some((path, _)) => match std::fs::canonicalize(path) {
                Ok(canonical) if canonical.to_string_lossy() == marker => {
                    return Ok(Plan::Inactive { warning: None });
                }
                _ => {
                    return Err(format!(
                        "NVIDIA_RUNTIME_INVALID: {ACTIVE_MARKER} does not match the resolved runtime path"
                    ));
                }
            },
            None => {
                return Err(format!(
                    "NVIDIA_RUNTIME_INVALID: {ACTIVE_MARKER} is set but no runtime path is configured"
                ));
            }
        }
    }
    // Caller-owned manual runtime: with no explicit pack override, a supplied
    // ORT_DYLIB_PATH means the operator owns runtime selection. Do not
    // auto-discover or re-exec a pack, and do not preemptively reject
    // CUDA/auto — existing native provider logic validates the manual
    // runtime fail-closed. An explicit pack override still wins (below).
    let explicit = matches!(&candidate, Some((_, true)));
    if !explicit && env.ort_dylib_path.as_deref().is_some_and(|v| !v.is_empty()) {
        return Ok(Plan::Inactive { warning: None });
    }
    let Some((path, explicit)) = candidate else {
        if explicit_cuda_requested(env) {
            return Err(format!(
                "NVIDIA_RUNTIME_UNAVAILABLE: an explicit CUDA provider needs an installed runtime pack; \
                 install it or select {ONNX_ENV}=cpu"
            ));
        }
        return Ok(Plan::Inactive { warning: None });
    };
    let pack = match validate_pack(&path, pin) {
        Ok(pack) => pack,
        Err(error) if explicit => return Err(error),
        Err(error) => {
            if explicit_cuda_requested(env) {
                return Err(error);
            }
            return Ok(Plan::Inactive {
                warning: Some(format!(
                    "ignoring invalid auto-discovered runtime at {}: {error}",
                    path.display()
                )),
            });
        }
    };
    let providers = resolve_providers(
        env.onnx_provider.as_deref(),
        env.nonlocal_provider.as_deref(),
        true,
    );
    if !provider_needs_cuda(&providers) {
        return Ok(Plan::Inactive { warning: None });
    }
    let lib_dir = pack.root.join("lib");
    let ld_value = match env.ld_library_path.as_deref().filter(|v| !v.is_empty()) {
        Some(previous) => format!("{}:{previous}", lib_dir.display()),
        None => lib_dir.display().to_string(),
    };
    let mut child_env = vec![
        (ORT_ENV.to_owned(), pack.ort_library.display().to_string()),
        (LD_ENV.to_owned(), ld_value),
        (ACTIVE_MARKER.to_owned(), pack.root.display().to_string()),
    ];
    if env.onnx_provider.is_none() {
        child_env.push((ONNX_ENV.to_owned(), providers.onnx.clone()));
    }
    if env.nonlocal_provider.is_none() {
        child_env.push((NONLOCAL_ENV.to_owned(), providers.nonlocal.clone()));
    }
    let target = match env.appimage.as_deref().filter(|v| !v.is_empty()) {
        Some(appimage) => {
            let target = PathBuf::from(appimage);
            if !target.is_absolute() {
                return Err(format!(
                    "NVIDIA_RUNTIME_INVALID: {APPIMAGE_ENV} must be an absolute path, got {appimage:?}"
                ));
            }
            target
        }
        None => current_exe.to_owned(),
    };
    Ok(Plan::Activate(Activation {
        pack_root: pack.root,
        ort_library: pack.ort_library,
        child_env,
        target,
    }))
}

/// Bundled CPU ORT fallback for desktop setup: a caller-supplied runtime
/// (pack activation via re-exec, or a manual `ORT_DYLIB_PATH`) always wins;
/// the bundled library is only a default when nothing else is configured.
pub(crate) fn bundled_ort_fallback(
    existing: Option<OsString>,
    bundled: PathBuf,
) -> Option<PathBuf> {
    if existing.is_some() {
        None
    } else {
        Some(bundled)
    }
}

/// Pre-Tauri entry point for Linux x86_64; a no-op on other platforms.
/// Re-exec diverges (never returns); errors exit non-zero with a clear
/// stderr message before any ONNX library can load.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub fn maybe_activate() {
    use std::os::unix::process::CommandExt;
    let env = EnvSnapshot::from_env();
    let current_exe = std::env::current_exe().unwrap_or_default();
    let pin = match load_release_pin() {
        Ok(pin) => pin,
        Err(error) => {
            eprintln!("RapidRAW NVIDIA runtime: invalid release metadata: {error}");
            std::process::exit(1);
        }
    };
    match plan(&env, true, &current_exe, &pin) {
        Ok(Plan::Inactive { warning }) => {
            if let Some(warning) = warning {
                eprintln!("RapidRAW NVIDIA runtime: {warning}");
            }
        }
        Ok(Plan::Activate(activation)) => {
            let args: Vec<OsString> = std::env::args_os().skip(1).collect();
            eprintln!(
                "RapidRAW NVIDIA runtime: activating {} ({})",
                activation.pack_root.display(),
                activation.ort_library.display()
            );
            let error = std::process::Command::new(&activation.target)
                .args(args)
                .envs(activation.child_env)
                .exec();
            eprintln!(
                "RapidRAW NVIDIA runtime: re-exec of {} failed: {error}",
                activation.target.display()
            );
            std::process::exit(1);
        }
        Err(error) => {
            eprintln!("RapidRAW NVIDIA runtime: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub fn maybe_activate() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin_for(manifest_bytes: &[u8]) -> ReleasePin {
        ReleasePin {
            schema: RELEASE_SCHEMA.to_owned(),
            runtime_tag: "nvidia-runtime-v1.0.0".to_owned(),
            pack_name: "TEST-PACK".to_owned(),
            manifest_schema: "rapidraw-linux-nvidia-runtime-manifest-v1".to_owned(),
            asset: "TEST-PACK.tgz".to_owned(),
            asset_sha256: "0".repeat(64),
            asset_size: 1,
            runtime_json_sha256: sha256_hex(manifest_bytes),
            os: "linux".to_owned(),
            arch: "x86_64".to_owned(),
        }
    }

    fn manifest_bytes(schema: &str, pack: &str, os: &str, arch: &str) -> Vec<u8> {
        serde_json::json!({
            "manifest_schema": schema,
            "pack": pack,
            "os": os,
            "arch": arch,
        })
        .to_string()
        .into_bytes()
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        pin: ReleasePin,
    }

    fn valid_pack() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("pack");
        std::fs::create_dir_all(root.join("lib")).expect("lib dir");
        std::fs::write(root.join("lib").join("libonnxruntime.so"), b"ELF-FAKE").expect("ort lib");
        let bytes = manifest_bytes(
            "rapidraw-linux-nvidia-runtime-manifest-v1",
            "TEST-PACK",
            "linux",
            "x86_64",
        );
        std::fs::write(root.join("runtime.json"), &bytes).expect("manifest");
        let pin = pin_for(&bytes);
        Fixture {
            _dir: dir,
            root,
            pin,
        }
    }

    fn env_with_pack(root: &Path) -> EnvSnapshot {
        EnvSnapshot {
            runtime_override: Some(root.to_string_lossy().into_owned()),
            ..EnvSnapshot::default()
        }
    }

    fn child_env_map(activation: &Activation) -> std::collections::BTreeMap<&str, &str> {
        activation
            .child_env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect()
    }

    #[test]
    fn release_metadata_parses() {
        let pin = load_release_pin().expect("tracked release metadata parses");
        assert_eq!(pin.schema, RELEASE_SCHEMA);
        assert_eq!(pin.runtime_tag, "nvidia-runtime-v1.0.0");
        assert_eq!(pin.os, "linux");
        assert_eq!(pin.arch, "x86_64");
        assert_eq!(pin.asset_sha256.len(), 64);
        assert_eq!(pin.runtime_json_sha256.len(), 64);
    }

    #[test]
    fn wrong_release_schema_rejected() {
        let tampered = RELEASE_METADATA.replace(
            "rapidraw-linux-nvidia-runtime-release-v1",
            "rapidraw-linux-nvidia-runtime-release-v9",
        );
        assert_ne!(tampered, RELEASE_METADATA);
        let error = parse_release_pin(&tampered).expect_err("wrong schema must fail");
        assert!(error.to_string().contains("unsupported schema"), "{error}");
    }

    #[test]
    fn non_linux_is_noop() {
        let plan = plan(
            &EnvSnapshot::default(),
            false,
            Path::new("/fake/RapidRAW"),
            &pin_for(b"{}"),
        )
        .expect("plan");
        assert!(matches!(plan, Plan::Inactive { warning: None }));
    }

    #[test]
    fn no_pack_means_cpu_startup() {
        let env = EnvSnapshot::default();
        let plan = plan(&env, true, Path::new("/fake/RapidRAW"), &pin_for(b"{}")).expect("plan");
        assert!(matches!(plan, Plan::Inactive { warning: None }));
    }

    #[test]
    fn off_disables_discovered_pack() {
        let fixture = valid_pack();
        let current = fixture._dir.path().join("current");
        std::os::unix::fs::symlink(&fixture.root, &current).expect("symlink");
        let env = EnvSnapshot {
            runtime_override: Some("off".to_owned()),
            ..EnvSnapshot::default()
        };
        let plan = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        assert!(matches!(plan, Plan::Inactive { warning: None }));
    }

    #[test]
    fn explicit_valid_pack_activates_with_cuda_defaults() {
        let fixture = valid_pack();
        let env = env_with_pack(&fixture.root);
        let plan = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        let Plan::Activate(activation) = plan else {
            panic!("expected activation");
        };
        let vars = child_env_map(&activation);
        let canonical = fixture.root.canonicalize().expect("canonical");
        assert_eq!(
            vars[ORT_ENV],
            canonical
                .join("lib")
                .join("libonnxruntime.so")
                .to_string_lossy()
        );
        assert_eq!(vars[LD_ENV], canonical.join("lib").to_string_lossy());
        assert_eq!(vars[ACTIVE_MARKER], canonical.to_string_lossy());
        assert_eq!(vars[ONNX_ENV], "cuda");
        assert_eq!(vars[NONLOCAL_ENV], "cuda");
        assert_eq!(activation.target, Path::new("/fake/RapidRAW"));
    }

    #[test]
    fn explicit_missing_pack_errors() {
        let fixture = valid_pack();
        let env = env_with_pack(&fixture._dir.path().join("absent"));
        let error = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin)
            .expect_err("missing explicit pack must fail");
        assert!(error.contains("NVIDIA_RUNTIME_INVALID"), "{error}");
    }

    #[test]
    fn explicit_relative_pack_errors() {
        let fixture = valid_pack();
        let env = EnvSnapshot {
            runtime_override: Some("relative/pack".to_owned()),
            ..EnvSnapshot::default()
        };
        let error = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin)
            .expect_err("relative explicit pack must fail");
        assert!(error.contains("absolute"), "{error}");
    }

    #[test]
    fn auto_current_valid_pack_selected() {
        let fixture = valid_pack();
        let current = fixture._dir.path().join("current");
        std::os::unix::fs::symlink(&fixture.root, &current).expect("symlink");
        let xdg = fixture._dir.path().join("data");
        std::fs::create_dir_all(xdg.join("rapidraw").join("nvidia-runtime")).expect("dirs");
        std::os::unix::fs::symlink(
            &current,
            xdg.join("rapidraw").join("nvidia-runtime").join("current"),
        )
        .expect("current");
        let env = EnvSnapshot {
            xdg_data_home: Some(xdg.to_string_lossy().into_owned()),
            ..EnvSnapshot::default()
        };
        let plan = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        let Plan::Activate(activation) = plan else {
            panic!("expected activation");
        };
        assert_eq!(
            activation.pack_root,
            fixture.root.canonicalize().expect("canonical")
        );
    }

    #[test]
    fn manifest_mismatches_rejected() {
        let fixture = valid_pack();
        for (schema, pack, os, arch) in [
            ("wrong-schema", "TEST-PACK", "linux", "x86_64"),
            (
                "rapidraw-linux-nvidia-runtime-manifest-v1",
                "OTHER-PACK",
                "linux",
                "x86_64",
            ),
            (
                "rapidraw-linux-nvidia-runtime-manifest-v1",
                "TEST-PACK",
                "macos",
                "x86_64",
            ),
            (
                "rapidraw-linux-nvidia-runtime-manifest-v1",
                "TEST-PACK",
                "linux",
                "aarch64",
            ),
        ] {
            let dir = tempfile::tempdir().expect("tempdir");
            let root = dir.path().join("pack");
            std::fs::create_dir_all(root.join("lib")).expect("lib");
            std::fs::write(root.join("lib").join("libonnxruntime.so"), b"ELF-FAKE").expect("lib");
            let bytes = manifest_bytes(schema, pack, os, arch);
            std::fs::write(root.join("runtime.json"), &bytes).expect("manifest");
            // Pin still expects the valid manifest bytes, so a content swap
            // is caught by the SHA gate before field checks.
            let error = plan(
                &env_with_pack(&root),
                true,
                Path::new("/fake/RapidRAW"),
                &fixture.pin,
            )
            .expect_err("mismatched manifest must fail");
            assert!(error.contains("NVIDIA_RUNTIME_MISMATCH"), "{error}");
        }
        // Wrong schema with a matching SHA is caught by the field gate.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("pack");
        std::fs::create_dir_all(root.join("lib")).expect("lib");
        std::fs::write(root.join("lib").join("libonnxruntime.so"), b"ELF-FAKE").expect("lib");
        let bytes = manifest_bytes("wrong-schema", "TEST-PACK", "linux", "x86_64");
        std::fs::write(root.join("runtime.json"), &bytes).expect("manifest");
        let pin = pin_for(&bytes);
        let error = plan(
            &env_with_pack(&root),
            true,
            Path::new("/fake/RapidRAW"),
            &pin,
        )
        .expect_err("wrong schema must fail");
        assert!(error.contains("manifest schema"), "{error}");
    }

    #[test]
    fn auto_invalid_pack_warns_unless_cuda_requested() {
        let fixture = valid_pack();
        let bogus = fixture._dir.path().join("bogus");
        std::fs::create_dir_all(&bogus).expect("bogus dir");
        let xdg = fixture._dir.path().join("data");
        std::fs::create_dir_all(xdg.join("rapidraw").join("nvidia-runtime")).expect("dirs");
        std::os::unix::fs::symlink(
            &bogus,
            xdg.join("rapidraw").join("nvidia-runtime").join("current"),
        )
        .expect("current");
        let base = EnvSnapshot {
            xdg_data_home: Some(xdg.to_string_lossy().into_owned()),
            ..EnvSnapshot::default()
        };
        let planned = plan(&base, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        assert!(
            matches!(planned, Plan::Inactive { warning: Some(_) }),
            "auto-invalid pack warns and stays on CPU"
        );
        for provider_env in [(ONNX_ENV, "cuda"), (NONLOCAL_ENV, "cuda")] {
            let mut env = base.clone();
            if provider_env.0 == ONNX_ENV {
                env.onnx_provider = Some("cuda".to_owned());
            } else {
                env.nonlocal_provider = Some("cuda".to_owned());
            }
            let error = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin)
                .expect_err("explicit CUDA with invalid pack must fail");
            assert!(error.contains("NVIDIA_RUNTIME"), "{error}");
        }
    }

    #[test]
    fn explicit_onnx_cpu_is_never_promoted() {
        let fixture = valid_pack();
        let env = EnvSnapshot {
            onnx_provider: Some("cpu".to_owned()),
            ..env_with_pack(&fixture.root)
        };
        let plan = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        assert!(
            matches!(plan, Plan::Inactive { warning: None }),
            "explicit CPU stays on CPU even with a valid pack"
        );
    }

    #[test]
    fn mixed_providers_activate_and_preserve_choices() {
        let fixture = valid_pack();
        let env = EnvSnapshot {
            onnx_provider: Some("cpu".to_owned()),
            nonlocal_provider: Some("cuda".to_owned()),
            ..env_with_pack(&fixture.root)
        };
        let plan = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        let Plan::Activate(activation) = plan else {
            panic!("Nonlocal CUDA needs the pack");
        };
        let vars = child_env_map(&activation);
        assert!(!vars.contains_key(ONNX_ENV), "explicit ONNX preserved");
        assert!(
            !vars.contains_key(NONLOCAL_ENV),
            "explicit Nonlocal preserved"
        );
    }

    #[test]
    fn ld_library_path_is_prepended_not_replaced() {
        let fixture = valid_pack();
        let env = EnvSnapshot {
            ld_library_path: Some("/usr/lib/stuff".to_owned()),
            ..env_with_pack(&fixture.root)
        };
        let plan = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        let Plan::Activate(activation) = plan else {
            panic!("expected activation");
        };
        let vars = child_env_map(&activation);
        assert_eq!(
            vars[LD_ENV],
            format!(
                "{}:/usr/lib/stuff",
                fixture
                    .root
                    .canonicalize()
                    .expect("canonical")
                    .join("lib")
                    .display()
            )
        );
    }

    #[test]
    fn active_marker_prevents_loop_and_rejects_mismatch() {
        let fixture = valid_pack();
        let canonical = fixture.root.canonicalize().expect("canonical");
        let env = EnvSnapshot {
            active_marker: Some(canonical.to_string_lossy().into_owned()),
            ..env_with_pack(&fixture.root)
        };
        let planned = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        assert!(matches!(planned, Plan::Inactive { warning: None }));
        let env = EnvSnapshot {
            active_marker: Some("/elsewhere/pack".to_owned()),
            ..env_with_pack(&fixture.root)
        };
        let error = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin)
            .expect_err("contradictory marker must fail");
        assert!(error.contains("ACTIVE"), "{error}");
    }

    #[test]
    fn onnx_auto_still_needs_pack() {
        let fixture = valid_pack();
        let env = EnvSnapshot {
            onnx_provider: Some("auto".to_owned()),
            ..env_with_pack(&fixture.root)
        };
        let plan = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        assert!(matches!(plan, Plan::Activate(_)));
    }

    #[test]
    fn explicit_cuda_without_pack_fails() {
        let env = EnvSnapshot {
            onnx_provider: Some("cuda".to_owned()),
            ..EnvSnapshot::default()
        };
        let error = plan(&env, true, Path::new("/fake/RapidRAW"), &pin_for(b"{}"))
            .expect_err("explicit CUDA without a pack must fail");
        assert!(error.contains("NVIDIA_RUNTIME_UNAVAILABLE"), "{error}");
    }

    #[test]
    fn appimage_target_selection() {
        let fixture = valid_pack();
        let env = EnvSnapshot {
            appimage: Some("/mnt/image/RapidRAW.AppImage".to_owned()),
            ..env_with_pack(&fixture.root)
        };
        let planned = plan(&env, true, Path::new("/proc/self/exe"), &fixture.pin).expect("plan");
        let Plan::Activate(activation) = planned else {
            panic!("expected activation");
        };
        assert_eq!(activation.target, Path::new("/mnt/image/RapidRAW.AppImage"));
        let env = EnvSnapshot {
            appimage: Some("relative.AppImage".to_owned()),
            ..env_with_pack(&fixture.root)
        };
        let error = plan(&env, true, Path::new("/proc/self/exe"), &fixture.pin)
            .expect_err("relative APPIMAGE must fail");
        assert!(error.contains("APPIMAGE"), "{error}");
    }

    fn env_with_manual_ort(ort: &str) -> EnvSnapshot {
        EnvSnapshot {
            ort_dylib_path: Some(ort.to_owned()),
            ..EnvSnapshot::default()
        }
    }

    #[test]
    fn manual_ort_cuda_reaches_native_logic() {
        // No pack configured at all: caller-owned runtime must not be
        // preemptively rejected; native provider code validates it.
        for onnx in [Some("cuda"), Some("auto"), None] {
            let mut env = env_with_manual_ort("/opt/manual/lib/libonnxruntime.so");
            env.onnx_provider = onnx.map(str::to_owned);
            let planned =
                plan(&env, true, Path::new("/fake/RapidRAW"), &pin_for(b"{}")).expect("plan");
            assert!(
                matches!(planned, Plan::Inactive { warning: None }),
                "manual ORT + {onnx:?} stays inactive"
            );
        }
    }

    #[test]
    fn manual_ort_wins_over_discovered_current() {
        let fixture = valid_pack();
        let current = fixture._dir.path().join("current");
        std::os::unix::fs::symlink(&fixture.root, &current).expect("symlink");
        let xdg = fixture._dir.path().join("data");
        std::fs::create_dir_all(xdg.join("rapidraw").join("nvidia-runtime")).expect("dirs");
        std::os::unix::fs::symlink(
            &current,
            xdg.join("rapidraw").join("nvidia-runtime").join("current"),
        )
        .expect("current");
        let mut env = env_with_manual_ort("/opt/manual/lib/libonnxruntime.so");
        env.xdg_data_home = Some(xdg.to_string_lossy().into_owned());
        let planned = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        assert!(
            matches!(planned, Plan::Inactive { warning: None }),
            "manual ORT wins over auto-discovered pack"
        );
    }

    #[test]
    fn explicit_pack_wins_over_manual_ort() {
        let fixture = valid_pack();
        let mut env = env_with_pack(&fixture.root);
        env.ort_dylib_path = Some("/opt/manual/lib/libonnxruntime.so".to_owned());
        let planned = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        let Plan::Activate(activation) = planned else {
            panic!("explicit pack must win over manual ORT");
        };
        let vars = child_env_map(&activation);
        assert_eq!(
            vars[ORT_ENV],
            fixture
                .root
                .canonicalize()
                .expect("canonical")
                .join("lib")
                .join("libonnxruntime.so")
                .to_string_lossy()
        );
    }

    #[test]
    fn off_with_manual_ort_stays_inactive() {
        let mut env = env_with_manual_ort("/opt/manual/lib/libonnxruntime.so");
        env.runtime_override = Some("off".to_owned());
        env.onnx_provider = Some("cuda".to_owned());
        let planned = plan(&env, true, Path::new("/fake/RapidRAW"), &pin_for(b"{}")).expect("plan");
        assert!(matches!(planned, Plan::Inactive { warning: None }));
    }

    #[test]
    fn active_child_with_pack_ort_does_not_loop() {
        let fixture = valid_pack();
        let canonical = fixture.root.canonicalize().expect("canonical");
        let env = EnvSnapshot {
            active_marker: Some(canonical.to_string_lossy().into_owned()),
            ort_dylib_path: Some(
                canonical
                    .join("lib")
                    .join("libonnxruntime.so")
                    .to_string_lossy()
                    .into_owned(),
            ),
            ..env_with_pack(&fixture.root)
        };
        let planned = plan(&env, true, Path::new("/fake/RapidRAW"), &fixture.pin).expect("plan");
        assert!(matches!(planned, Plan::Inactive { warning: None }));
    }

    #[test]
    fn bundled_ort_fallback_prefers_existing_override() {
        assert_eq!(
            bundled_ort_fallback(
                Some(OsString::from("/pack/lib/libonnxruntime.so")),
                PathBuf::from("/bundled/libonnxruntime.so")
            ),
            None
        );
        assert_eq!(
            bundled_ort_fallback(None, PathBuf::from("/bundled/libonnxruntime.so")),
            Some(PathBuf::from("/bundled/libonnxruntime.so"))
        );
    }
}
