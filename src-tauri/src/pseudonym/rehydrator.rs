use crate::pseudonym::mapping::MappingTable;

/// Rehydrates responses by replacing tokens with original values
pub struct Rehydrator;

impl Rehydrator {
    /// Replace all tokens in the response text with their original values.
    /// Works for both streaming chunks and complete responses.
    pub fn rehydrate(text: &str, mapping_table: &mut MappingTable) -> String {
        let mut result = text.to_string();

        // Collect all active mappings
        let replacements: Vec<(String, String)> = mapping_table
            .all_mappings()
            .iter()
            .map(|(token, mapping)| (token.clone(), mapping.original.clone()))
            .collect();

        // Replace tokens with originals
        for (token, original) in replacements {
            result = result.replace(&token, &original);
        }

        result
    }

    /// Rehydrate a streaming SSE chunk.
    /// SSE chunks have the format: `data: {json}\n\n`
    /// We need to parse the JSON, rehydrate the content field, and reconstruct.
    pub fn rehydrate_sse_chunk(chunk: &str, mapping_table: &mut MappingTable) -> String {
        let mut result = String::new();

        for line in chunk.lines() {
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    result.push_str("data: [DONE]\n");
                    continue;
                }

                // Try to parse as JSON and rehydrate content
                match serde_json::from_str::<serde_json::Value>(data) {
                    Ok(mut json) => {
                        Self::rehydrate_json_value(&mut json, mapping_table);
                        result.push_str(&format!("data: {}\n", serde_json::to_string(&json).unwrap_or_else(|_| data.to_string())));
                    }
                    Err(_) => {
                        // Not valid JSON — just rehydrate the raw text
                        result.push_str(&format!("data: {}\n", Self::rehydrate(data, mapping_table)));
                    }
                }
            } else if !line.is_empty() {
                result.push_str(line);
                result.push('\n');
            }
        }

        if !result.ends_with('\n') {
            result.push('\n');
        }
        result.push('\n');

        result
    }

    /// Recursively rehydrate string values in a JSON structure
    fn rehydrate_json_value(value: &mut serde_json::Value, mapping_table: &mut MappingTable) {
        match value {
            serde_json::Value::String(s) => {
                *s = Self::rehydrate(s, mapping_table);
            }
            serde_json::Value::Array(arr) => {
                for item in arr.iter_mut() {
                    Self::rehydrate_json_value(item, mapping_table);
                }
            }
            serde_json::Value::Object(obj) => {
                for (_key, val) in obj.iter_mut() {
                    Self::rehydrate_json_value(val, mapping_table);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pii::recognizers::PiiType;
    use crate::pseudonym::mapping::TokenMapping;

    fn make_table() -> MappingTable {
        let mut table = MappingTable::with_default_ttl();
        table.add_mappings(vec![
            TokenMapping {
                token: "[Email_1]".into(),
                original: "john@acme.com".into(),
                pii_type: PiiType::Email,
                confidence: 0.9,
            },
            TokenMapping {
                token: "[IP_Address_1]".into(),
                original: "192.168.1.1".into(),
                pii_type: PiiType::IpAddress,
                confidence: 0.9,
            },
        ]);
        table
    }

    #[test]
    fn test_basic_rehydration() {
        let mut table = make_table();
        let result = Rehydrator::rehydrate("Send to [Email_1] at [IP_Address_1]", &mut table);
        assert_eq!(result, "Send to john@acme.com at 192.168.1.1");
    }

    #[test]
    fn test_rehydration_no_tokens() {
        let mut table = make_table();
        let result = Rehydrator::rehydrate("No tokens here", &mut table);
        assert_eq!(result, "No tokens here");
    }

    #[test]
    fn test_rehydration_token_dropped_by_upstream() {
        let mut table = make_table();
        // If the upstream model drops or modifies a token, it just stays as-is
        let result = Rehydrator::rehydrate("The email [Email_1] and some token [NonExistent_1]", &mut table);
        assert_eq!(result, "The email john@acme.com and some token [NonExistent_1]");
    }

    #[test]
    fn test_rehydrate_sse_chunk() {
        let mut table = make_table();
        let chunk = r#"data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":"Email [Email_1]"},"index":0}]}"#;
        let result = Rehydrator::rehydrate_sse_chunk(chunk, &mut table);
        assert!(result.contains("john@acme.com"));
        assert!(!result.contains("[Email_1]"));
    }
}
