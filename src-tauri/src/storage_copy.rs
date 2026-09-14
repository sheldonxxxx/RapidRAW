//! Independent file copies that share filesystem blocks when supported.
use std::{fs, io, path::Path};

/// Create a new regular file without replacing an existing destination.
/// Clones are independent files; writes never modify the source.
pub fn copy_new(source: &Path, target: &Path) -> io::Result<()> {
    let source_info = fs::symlink_metadata(source)?;
    if !source_info.is_file() || source_info.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a regular source file",
        ));
    }
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        unsafe extern "C" {
            fn clonefile(
                source: *const std::ffi::c_char,
                target: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        let source_name = CString::new(source.as_os_str().as_bytes())?;
        let target_name = CString::new(target.as_os_str().as_bytes())?;
        if unsafe { clonefile(source_name.as_ptr(), target_name.as_ptr(), 0) } == 0 {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(target, fs::Permissions::from_mode(0o600))?;
            return fs::File::open(target)?.sync_all();
        }
        let error = io::Error::last_os_error();
        // Cross-device copies and filesystems without cloning use streaming IO.
        if !matches!(error.raw_os_error(), Some(18 | 22 | 45 | 78)) {
            return Err(error);
        }
    }
    copy_streamed(source, target)
}

fn copy_streamed(source: &Path, target: &Path) -> io::Result<()> {
    let mut input = fs::File::open(source)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let result = io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    if result.is_err() {
        drop(output);
        let _ = fs::remove_file(target);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn exercise(copy: fn(&Path, &Path) -> io::Result<()>, label: &str) {
        let root =
            std::env::temp_dir().join(format!("rapidraw-copy-{}-{label}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let target = root.join("target");
        fs::write(&source, vec![91u8; 2 * 1024 * 1024]).unwrap();
        copy(&source, &target).unwrap();
        assert_eq!(fs::read(&source).unwrap(), fs::read(&target).unwrap());
        assert_eq!(
            copy(&source, &target).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .unwrap()
            .write_all(b"edited")
            .unwrap();
        assert_eq!(&fs::read(&source).unwrap()[..6], &[91; 6]);
        assert_eq!(&fs::read(&target).unwrap()[..6], b"edited");
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, symlink};
            assert_ne!(
                fs::metadata(&source).unwrap().ino(),
                fs::metadata(&target).unwrap().ino()
            );
            let link = root.join("link");
            symlink(&source, &link).unwrap();
            assert!(copy_new(&link, &root.join("rejected")).is_err());
            assert!(copy_new(&source, &link).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_clone_and_no_clobber() {
        exercise(copy_new, "clone");
    }

    #[test]
    fn independent_streaming_fallback_and_no_clobber() {
        exercise(copy_streamed, "stream");
    }
}
