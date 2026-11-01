//! Linked inverse masks. A parent with `linkedInverseOf` keeps an inverted copy of
//! another parent's selection components while owning its own name, opacity and
//! local adjustments. The copy is ordinary mask data, so the renderer and desktop
//! editor need no special handling; the bridge refreshes it on every commit.
use super::Result;
use serde_json::{Value, json};

pub(super) const LINK_KEY: &str = "linkedInverseOf";

/// Stable component ID for a linked copy, unique within the session. Bitmap
/// caches are keyed by component content, so refreshed content under the same
/// ID never reuses a stale selection.
fn linked_component_id(linked_mask: &str, source_component: &str) -> String {
    let digest = blake3::hash(format!("{linked_mask}\u{0}{source_component}").as_bytes());
    let h = digest.to_hex();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Refresh every linked parent from its source. Returns warnings for links that
/// were dropped because their source no longer exists.
pub(super) fn sync_linked_masks(adjustments: &mut Value) -> Result<Vec<String>> {
    let Some(masks) = adjustments["masks"].as_array_mut() else {
        return Ok(Vec::new());
    };
    let mut warnings = Vec::new();
    for index in 0..masks.len() {
        let Some(source_id) = masks[index][LINK_KEY].as_str().map(str::to_string) else {
            continue;
        };
        let own_id = masks[index]["id"].as_str().unwrap_or_default().to_string();
        if source_id == own_id {
            return Err(format!(
                "INVALID_MASK_LINK: mask {own_id} cannot be linked to itself"
            ));
        }
        let Some(source) = masks.iter().find(|m| m["id"] == source_id.as_str()) else {
            if let Some(map) = masks[index].as_object_mut() {
                map.remove(LINK_KEY);
            }
            warnings.push(format!(
                "Mask {own_id} was linked to {source_id}, which no longer exists; it keeps its last selection as an ordinary mask."
            ));
            continue;
        };
        if source.get(LINK_KEY).is_some_and(|v| !v.is_null()) {
            return Err(format!(
                "INVALID_MASK_LINK: mask {own_id} links to {source_id}, which is itself linked; link to the original selection instead"
            ));
        }
        let invert = !source["invert"].as_bool().unwrap_or(false);
        let mut components = source["subMasks"].clone();
        if let Some(parts) = components.as_array_mut() {
            for part in parts {
                let source_component = part["id"].as_str().unwrap_or_default().to_string();
                part["id"] = json!(linked_component_id(&own_id, &source_component));
            }
        }
        let linked = &mut masks[index];
        if linked["subMasks"] != components {
            linked["subMasks"] = components;
        }
        linked["invert"] = json!(invert);
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask(id: &str, invert: bool, components: Value) -> Value {
        json!({"id":id,"name":id,"visible":true,"invert":invert,"opacity":100,"adjustments":{},"subMasks":components})
    }

    #[test]
    fn linked_copy_follows_source_and_keeps_its_own_grade() {
        let mut adjustments = json!({"masks":[
            mask("subject", false, json!([{"id":"ai","type":"ai-subject","visible":true,"mode":"additive","parameters":{"grow":0}}])),
            mask("environment", true, json!([]))
        ]});
        adjustments["masks"][1][LINK_KEY] = json!("subject");
        adjustments["masks"][1]["adjustments"] = json!({"exposure":-0.5});
        sync_linked_masks(&mut adjustments).unwrap();
        let linked = &adjustments["masks"][1];
        assert_eq!(linked["invert"], true);
        assert_eq!(linked["subMasks"][0]["type"], "ai-subject");
        assert_ne!(linked["subMasks"][0]["id"], "ai");
        assert_eq!(linked["adjustments"]["exposure"], -0.5);
        let first_id = linked["subMasks"][0]["id"].clone();

        // A refined source (new parameters, same component id) and an added brush propagate.
        adjustments["masks"][0]["subMasks"][0]["parameters"]["grow"] = json!(-10);
        adjustments["masks"][0]["subMasks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"brush","type":"brush","visible":true,"mode":"subtractive","parameters":{"lines":[]}}));
        sync_linked_masks(&mut adjustments).unwrap();
        let linked = &adjustments["masks"][1];
        assert_eq!(linked["subMasks"].as_array().unwrap().len(), 2);
        assert_eq!(linked["subMasks"][0]["parameters"]["grow"], -10);
        assert_eq!(
            linked["subMasks"][0]["id"], first_id,
            "stable component ids"
        );
        assert_eq!(linked["subMasks"][1]["mode"], "subtractive");
    }

    #[test]
    fn inverting_the_source_flips_the_linked_copy() {
        let mut adjustments =
            json!({"masks":[mask("a", true, json!([])), mask("b", false, json!([]))]});
        adjustments["masks"][1][LINK_KEY] = json!("a");
        sync_linked_masks(&mut adjustments).unwrap();
        assert_eq!(adjustments["masks"][1]["invert"], false);
    }

    #[test]
    fn removed_source_leaves_an_ordinary_mask_with_a_warning() {
        let mut adjustments = json!({"masks":[mask("b", true, json!([{"id":"x","type":"brush","visible":true,"mode":"additive","parameters":{"lines":[]}}]))]});
        adjustments["masks"][0][LINK_KEY] = json!("gone");
        let warnings = sync_linked_masks(&mut adjustments).unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(adjustments["masks"][0].get(LINK_KEY).is_none());
        assert_eq!(adjustments["masks"][0]["subMasks"][0]["id"], "x");
    }

    #[test]
    fn self_and_chained_links_are_rejected() {
        let mut own = json!({"masks":[mask("a", false, json!([]))]});
        own["masks"][0][LINK_KEY] = json!("a");
        assert!(sync_linked_masks(&mut own).is_err());
        let mut chain = json!({"masks":[mask("a", false, json!([])), mask("b", true, json!([])), mask("c", false, json!([]))]});
        chain["masks"][1][LINK_KEY] = json!("a");
        chain["masks"][2][LINK_KEY] = json!("b");
        assert!(sync_linked_masks(&mut chain).is_err());
    }

    #[test]
    fn component_ids_are_distinct_per_linked_parent() {
        assert_ne!(
            linked_component_id("env-1", "ai"),
            linked_component_id("env-2", "ai")
        );
        assert_eq!(linked_component_id("env", "ai").len(), 36);
    }
}
