//! Verified model seeds shared by isolated workspaces on this host.
use super::Result;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

pub(super) fn directory(handle: &tauri::AppHandle) -> Result<PathBuf> {
    let path = match std::env::var_os("RAPIDRAW_MODEL_CACHE") {
        Some(path) => PathBuf::from(path),
        None => handle
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("verified-models"),
    };
    if !path.is_absolute() {
        return Err("INVALID_PATH: RAPIDRAW_MODEL_CACHE must be absolute".into());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    if path.canonicalize().map_err(|e| e.to_string())? != path {
        return Err("INVALID_PATH: Model cache must not contain symlinks".into());
    }
    Ok(path)
}

pub(super) fn lookup(cache: &Path, hash: &str) -> Result<Option<PathBuf>> {
    if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("INVALID_MODEL: Expected SHA-256".into());
    }
    let path = cache.join(format!("{}.onnx", hash.to_ascii_lowercase()));
    let info = match fs::symlink_metadata(&path) {
        Ok(info) => info,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !info.is_file()
        || info.file_type().is_symlink()
        || crate::ai_enhance::digest(&path).map_err(|e| e.to_string())? != hash.to_ascii_lowercase()
    {
        return Err("MODEL_CACHE_INVALID: Cached model failed validation; remove that cache entry and retry".into());
    }
    Ok(Some(path))
}

pub(super) fn remember(cache: &Path, source: &Path, hash: &str) -> Result<()> {
    if lookup(cache, hash)?.is_some() {
        return Ok(());
    }
    let staging = tempfile::tempdir_in(cache).map_err(|e| e.to_string())?;
    let staged = staging.path().join("model.onnx");
    crate::storage_copy::copy_new(source, &staged).map_err(|e| e.to_string())?;
    if crate::ai_enhance::digest(&staged).map_err(|e| e.to_string())? != hash.to_ascii_lowercase() {
        return Err("MODEL_CHANGED: Model changed while populating the cache".into());
    }
    // Publish without overwriting another process's verified entry. The staging
    // name is removed immediately; this never links a workspace model itself.
    let target = cache.join(format!("{}.onnx", hash.to_ascii_lowercase()));
    match fs::hard_link(&staged, &target) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    lookup(cache, hash)?.ok_or("MODEL_CACHE_INVALID: Published model is missing")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_publish_keeps_one_verified_seed() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::write(&source, vec![37; 1024 * 1024]).unwrap();
        let hash = crate::ai_enhance::digest(&source).unwrap();
        let cache = dir.path().join("cache");
        fs::create_dir(&cache).unwrap();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| remember(&cache, &source, &hash).unwrap());
            }
        });
        assert!(lookup(&cache, &hash).unwrap().is_some());
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let other_hash = "a".repeat(64);
            symlink(&source, cache.join(format!("{other_hash}.onnx"))).unwrap();
            assert!(lookup(&cache, &other_hash).is_err());
        }
    }
    #[test]
    fn cache_is_verified_and_independent_of_workspace_edits() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        fs::create_dir(&cache).unwrap();
        let source = dir.path().join("model");
        fs::write(&source, b"model bytes").unwrap();
        let hash = crate::ai_enhance::digest(&source).unwrap();
        remember(&cache, &source, &hash).unwrap();
        remember(&cache, &source, &hash).unwrap();
        fs::write(&source, b"changed workspace").unwrap();
        let cached = lookup(&cache, &hash).unwrap().unwrap();
        assert_eq!(fs::read(&cached).unwrap(), b"model bytes");
        fs::write(&cached, b"corrupt").unwrap();
        assert!(
            lookup(&cache, &hash)
                .unwrap_err()
                .contains("MODEL_CACHE_INVALID")
        );
        assert!(lookup(&cache, "../escape").is_err());
    }
}
