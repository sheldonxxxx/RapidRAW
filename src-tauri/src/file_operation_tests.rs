use super::*;

fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, contents).unwrap();
    path
}

fn paths(files: &[&Path]) -> Vec<String> {
    files
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn same_basename_transfers_fail_before_writing_or_removing_sources() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    let dest = dir.path().join("destination");
    for folder in [&a, &b, &dest] {
        fs::create_dir(folder).unwrap();
    }
    let first = write(&a, "IMG_1.CR2", "first photo");
    let second = write(&b, "IMG_1.CR2", "second photo");
    let input = paths(&[&first, &second]);
    assert!(copy_files_on_disk(input.clone(), dest.to_string_lossy().into_owned()).is_err());
    assert!(plan_file_transfers(&input, &dest, false).is_err());
    assert_eq!(fs::read_to_string(first).unwrap(), "first photo");
    assert_eq!(fs::read_to_string(second).unwrap(), "second photo");
    assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
}

#[test]
fn in_place_copy_preserves_orphan_sidecars_and_deduplicates_virtual_sources() {
    let dir = tempfile::tempdir().unwrap();
    let image = write(dir.path(), "photo.CR3", "original");
    write(dir.path(), "photo.CR3.rrdata", "edit");
    write(dir.path(), "photo.CR3.abcdef.rrdata", "virtual edit");
    write(dir.path(), "photo.CR3.rrexif", "metadata");
    let unrelated = write(dir.path(), "photo.CR3.jpg.rrdata", "other image edit");
    let orphan = write(dir.path(), "photo_copy_1.CR3.rrdata", "orphan edit");
    let input = vec![
        image.to_string_lossy().into_owned(),
        format!("{}?vc=abcdef", image.display()),
    ];
    copy_files_on_disk(input, dir.path().to_string_lossy().into_owned()).unwrap();
    for (name, value) in [
        ("photo_copy_2.CR3", "original"),
        ("photo_copy_2.CR3.rrdata", "edit"),
        ("photo_copy_2.CR3.abcdef.rrdata", "virtual edit"),
        ("photo_copy_2.CR3.rrexif", "metadata"),
    ] {
        assert_eq!(fs::read_to_string(dir.path().join(name)).unwrap(), value);
    }
    assert_eq!(fs::read_to_string(unrelated).unwrap(), "other image edit");
    assert_eq!(fs::read_to_string(orphan).unwrap(), "orphan edit");
    assert!(!dir.path().join("photo_copy_1.CR3").exists());
    assert!(!dir.path().join("photo_copy_3.CR3").exists());
    assert!(!dir.path().join("photo_copy_2.CR3.jpg.rrdata").exists());
}

#[test]
fn associated_deletion_keeps_stems_scoped_to_the_selected_folder() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    let mut expected = HashSet::new();
    for (folder, selected, retained) in [(&a, "IMG_1", "IMG_2"), (&b, "IMG_2", "IMG_1")] {
        for suffix in [
            ".CR2",
            ".jpg",
            ".CR2.rrdata",
            ".CR2.abcdef.rrdata",
            ".CR2.rrexif",
        ] {
            expected.insert(write(folder, &format!("{selected}{suffix}"), "selected"));
            write(folder, &format!("{retained}{suffix}"), "retained");
        }
    }
    let input = paths(&[&a.join("IMG_1.CR2"), &b.join("IMG_2.CR2")]);
    assert_eq!(associated_deletion_candidates(&input), expected);
    assert_eq!(fs::read_dir(a).unwrap().count(), 10);
    assert_eq!(fs::read_dir(b).unwrap().count(), 10);
}

#[test]
fn rename_keeps_virtual_ids_and_sequence_order_without_taking_foreign_sidecars() {
    let dir = tempfile::tempdir().unwrap();
    let first = write(dir.path(), "first.CR3", "first");
    let second = write(dir.path(), "second.CR3", "second");
    write(dir.path(), "first.CR3.rrdata", "primary edit");
    write(dir.path(), "first.CR3.abcdef.rrdata", "virtual edit");
    write(dir.path(), "first.CR3.rrexif", "metadata");
    let foreign = write(dir.path(), "first.CR3.jpg.rrdata", "foreign edit");
    let input = vec![
        format!("{}?vc=abcdef", first.display()),
        first.to_string_lossy().into_owned(),
        second.to_string_lossy().into_owned(),
    ];
    let (result, _) = rename_files_on_disk(&input, "renamed_{sequence}").unwrap();
    let first_new = dir.path().join("renamed_1.CR3");
    let second_new = dir.path().join("renamed_2.CR3");
    assert_eq!(
        result,
        vec![
            format!("{}?vc=abcdef", first_new.display()),
            first_new.to_string_lossy().into_owned(),
            second_new.to_string_lossy().into_owned()
        ]
    );
    assert_eq!(fs::read_to_string(first_new).unwrap(), "first");
    assert_eq!(fs::read_to_string(second_new).unwrap(), "second");
    for (name, contents) in [
        ("renamed_1.CR3.rrdata", "primary edit"),
        ("renamed_1.CR3.abcdef.rrdata", "virtual edit"),
        ("renamed_1.CR3.rrexif", "metadata"),
    ] {
        assert_eq!(fs::read_to_string(dir.path().join(name)).unwrap(), contents);
    }
    assert_eq!(fs::read_to_string(foreign).unwrap(), "foreign edit");
    assert!(!first.exists());
    assert!(!second.exists());
}

#[test]
fn rename_rejects_duplicate_destinations_and_existing_sidecars_before_any_write() {
    let dir = tempfile::tempdir().unwrap();
    let first = write(dir.path(), "first.CR3", "first");
    let second = write(dir.path(), "second.CR3", "second");
    assert!(rename_files_on_disk(&paths(&[&first, &second]), "same").is_err());
    assert!(!dir.path().join("same.CR3").exists());
    write(dir.path(), "first.CR3.rrdata", "source edit");
    let orphan = write(dir.path(), "renamed.CR3.rrdata", "retained edit");
    assert!(rename_files_on_disk(&paths(&[&first]), "renamed").is_err());
    assert!(!dir.path().join("renamed.CR3").exists());
    assert_eq!(fs::read_to_string(first).unwrap(), "first");
    assert_eq!(fs::read_to_string(second).unwrap(), "second");
    assert_eq!(fs::read_to_string(orphan).unwrap(), "retained edit");
}

#[test]
fn xmp_tags_and_labels_round_trip_xml_entities_and_literal_dollars() {
    let dir = tempfile::tempdir().unwrap();
    let source = write(dir.path(), "photo.CR3", "fixture");
    let tags = vec![
        "R&D <$5> \"quoted\"".into(),
        "literal $1".into(),
        "color:blue&\"$1".into(),
    ];
    let metadata = ImageMetadata {
        tags: Some(tags.clone()),
        rating: 3,
        ..ImageMetadata::default()
    };
    // The second write exercises replacement of an existing subject bag and label.
    for _ in 0..2 {
        sync_metadata_to_xmp(&source, &metadata, true);
        let xml = fs::read_to_string(source.with_extension("xmp")).unwrap();
        assert!(xml.contains("R&amp;D &lt;$5&gt;"));
        assert!(xml.contains("literal $1"));
        assert!(xml.contains("Blue&amp;&quot;$1"));
        let mut restored = ImageMetadata::default();
        assert!(sync_metadata_from_xmp(&source, &mut restored));
        assert_eq!(restored.rating, 3);
        assert_eq!(restored.tags.unwrap(), tags);
    }
}
