use super::errors::OrchestratorError;
use super::types::{Plan, ReplanRequest, Subtask, SubtaskStatus, ValidationResult};

// ── Plan Contract Validation ────────────────────────────────────────────────

/// Validate that raw JSON conforms to the planning contract schema.
///
/// The planning model returns text that may contain JSON inside markdown
/// code fences. This function:
/// 1. Extracts JSON from the raw response (handles ```json ... ``` blocks)
/// 2. Validates that required top-level fields exist (`goal`, `subtasks`)
/// 3. Validates each subtask has required fields (`id`, `title`, `description`)
/// 4. Rejects plans with zero subtasks
///
/// Returns the parsed `Plan` on success, or a descriptive `OrchestratorError` on failure.
pub fn validate_plan_contract(raw: &str) -> Result<Plan, OrchestratorError> {
    let json_str = extract_json_from_response(raw)?;
    let value: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| OrchestratorError::InvalidPlanJson(e.to_string()))?;

    // ── Top-level required fields ────────────────────────────────────────
    let goal = value.get("goal")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| OrchestratorError::PlanSchemaValidation(
            "Plan contract missing required field 'goal' (non-empty string)".into()
        ))?;

    let subtasks_val = value.get("subtasks")
        .ok_or_else(|| OrchestratorError::PlanSchemaValidation(
            "Plan contract missing required field 'subtasks'".into()
        ))?;

    let subtasks_arr = subtasks_val.as_array()
        .ok_or_else(|| OrchestratorError::PlanSchemaValidation(
            "Plan contract field 'subtasks' must be an array".into()
        ))?;

    if subtasks_arr.is_empty() {
        return Err(OrchestratorError::PlanSchemaValidation(
            "Plan contract 'subtasks' array is empty — at least one subtask is required".into(),
        ));
    }

    // ── Parse each subtask ────────────────────────────────────────────────
    let mut subtasks = Vec::with_capacity(subtasks_arr.len());
    for (i, st_val) in subtasks_arr.iter().enumerate() {
        let st_obj = st_val.as_object().ok_or_else(|| {
            OrchestratorError::PlanSchemaValidation(format!(
                "subtasks[{i}] must be a JSON object"
            ))
        })?;

        let id = st_obj.get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OrchestratorError::PlanSchemaValidation(format!(
                "subtasks[{i}] missing required field 'id'"
            )))?
            .to_string();

        let title = st_obj.get("title")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OrchestratorError::PlanSchemaValidation(format!(
                "subtasks[{i}] missing required field 'title'"
            )))?
            .to_string();

        let description = st_obj.get("description")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OrchestratorError::PlanSchemaValidation(format!(
                "subtasks[{i}] missing required field 'description'"
            )))?
            .to_string();

        let allowed_files_raw = string_array_field(st_obj, "allowed_files", i, "subtask")?;

        // Warn and strip suspicious allowed_files entries (absolute paths, path traversal)
        let allowed_files: Vec<String> = allowed_files_raw
            .into_iter()
            .filter(|entry| {
                if !is_safe_relative_path(entry) {
                    tracing::warn!(
                        "subtasks[{i}] (id={id}) allowed_files: stripping unsafe path '{}'",
                        entry
                    );
                    return false;
                }
                true
            })
            .collect();
        let suggested_context_files = string_array_field(st_obj, "suggested_context_files", i, "subtask")?;
        let constraints = string_array_field(st_obj, "constraints", i, "subtask")?;
        let test_commands = string_array_field(st_obj, "test_commands", i, "subtask")?;
        let acceptance_criteria = string_array_field(st_obj, "acceptance_criteria", i, "subtask")?;
        let depends_on = string_array_field(st_obj, "depends_on", i, "subtask")?;

        // Warn (but don't reject) if acceptance_criteria or test_commands are empty
        // The plan is still valid but may produce suboptimal execution.
        if acceptance_criteria.is_empty() {
            tracing::warn!(
                "subtasks[{i}] (id={id}) has no acceptance_criteria — execution may be imprecise"
            );
        }
        if test_commands.is_empty() {
            tracing::warn!(
                "subtasks[{i}] (id={id}) has no test_commands — validation will be skipped"
            );
        }

        subtasks.push(Subtask {
            id,
            title,
            description,
            allowed_files,
            suggested_context_files,
            constraints,
            test_commands,
            acceptance_criteria,
            depends_on,
            retry_count: 0,
            status: SubtaskStatus::Pending,
        });
    }

    // Validate dependency graph: all depends_on references must exist
    let subtask_ids: Vec<&str> = subtasks.iter().map(|s| s.id.as_str()).collect();
    for st in &subtasks {
        for dep in &st.depends_on {
            if !subtask_ids.contains(&dep.as_str()) {
                return Err(OrchestratorError::PlanSchemaValidation(format!(
                    "subtask '{}' depends_on '{}' which does not exist in the plan",
                    st.id, dep
                )));
            }
        }
    }

    // Validate: no circular dependencies (simple check — all paths must terminate)
    if has_circular_dependency(&subtasks) {
        return Err(OrchestratorError::PlanSchemaValidation(
            "Plan contains circular subtask dependencies".into(),
        ));
    }

    let assumptions = string_array_field_root(&value, "assumptions")?;
    let global_constraints = string_array_field_root(&value, "global_constraints")?;
    let completion_definition = string_array_field_root(&value, "completion_definition")?;

    // task_id will be set by the caller (the orchestrator state machine)
    Ok(Plan {
        task_id: String::new(), // filled in by the caller
        goal: goal.to_string(),
        assumptions,
        subtasks,
        global_constraints,
        completion_definition,
    })
}

// ── Execution Contract ───────────────────────────────────────────────────────

/// Validate that an execution result has the minimum required fields.
///
/// The execution result is constructed programmatically (not parsed from LLM output),
/// so this is a structural check rather than a JSON parse.
pub fn validate_execution_result(result: &super::types::ExecutionResult) -> Result<(), OrchestratorError> {
    if result.subtask_id.is_empty() {
        return Err(OrchestratorError::PlanSchemaValidation(
            "ExecutionResult missing subtask_id".into(),
        ));
    }
    if !result.pi_completed && result.pi_summary.is_empty() {
        tracing::warn!(
            "Executor did not complete for subtask {} and produced no summary",
            result.subtask_id
        );
    }
    Ok(())
}

// ── Validation Contract ──────────────────────────────────────────────────────

/// Validate that a validation result has minimum required fields.
///
/// Like execution results, these are constructed programmatically, so
/// this is mainly a sanity check.
pub fn validate_validation_result(result: &ValidationResult) -> Result<(), OrchestratorError> {
    if result.subtask_id.is_empty() {
        return Err(OrchestratorError::PlanSchemaValidation(
            "ValidationResult missing subtask_id".into(),
        ));
    }
    Ok(())
}

// ── Replan Contract Validation ───────────────────────────────────────────────

/// Validate that raw JSON conforms to the replan contract schema.
///
/// Required fields: `reason`, `failed_subtask_id`, `revised_subtask` (with `id`, `title`).
pub fn validate_replan_contract(raw: &str) -> Result<ReplanRequest, OrchestratorError> {
    let json_str = extract_json_from_response(raw)?;
    let value: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| OrchestratorError::InvalidPlanJson(e.to_string()))?;

    let reason = value.get("reason")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| OrchestratorError::PlanSchemaValidation(
            "Replan contract missing required field 'reason' (non-empty string)".into()
        ))?
        .to_string();

    let failed_subtask_id = value.get("failed_subtask_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| OrchestratorError::PlanSchemaValidation(
            "Replan contract missing required field 'failed_subtask_id'".into()
        ))?
        .to_string();

    let failure_summary = string_array_field_root(&value, "failure_summary")?;

    let rs = value.get("revised_subtask")
        .and_then(|v| v.as_object())
        .ok_or_else(|| OrchestratorError::PlanSchemaValidation(
            "Replan contract missing required field 'revised_subtask' (must be an object)".into()
        ))?;

    let revised_id = rs.get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| OrchestratorError::PlanSchemaValidation(
            "revised_subtask missing required field 'id'".into()
        ))?
        .to_string();

    let revised_title = rs.get("title")
        .and_then(|v| v.as_str())
        .ok_or_else(|| OrchestratorError::PlanSchemaValidation(
            "revised_subtask missing required field 'title'".into()
        ))?
        .to_string();

    let allowed_files_raw = string_array_field(rs, "allowed_files", 0, "revised_subtask")?;

    // Warn and strip suspicious allowed_files entries (absolute paths, path traversal)
    let allowed_files: Vec<String> = allowed_files_raw
        .into_iter()
        .filter(|entry| {
            if !is_safe_relative_path(entry) {
                tracing::warn!(
                    "revised_subtask allowed_files: stripping unsafe path '{}'",
                    entry
                );
                return false;
            }
            true
        })
        .collect();
    let constraints = string_array_field(rs, "constraints", 0, "revised_subtask")?;
    let test_commands = string_array_field(rs, "test_commands", 0, "revised_subtask")?;
    let acceptance_criteria = string_array_field(rs, "acceptance_criteria", 0, "revised_subtask")?;

    Ok(ReplanRequest {
        reason,
        failed_subtask_id,
        failure_summary,
        revised_subtask: super::types::RevisedSubtask {
            id: revised_id,
            title: revised_title,
            allowed_files,
            constraints,
            test_commands,
            acceptance_criteria,
        },
    })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Extract JSON from a raw LLM response.
///
/// Handles three cases:
/// 1. Pure JSON string (starts with `{`)
/// 2. JSON inside a markdown code fence (```json ... ```)
/// 3. JSON inside a plain code fence (``` ... ```)
///
/// If no structured JSON is found, returns an error suggesting the model
/// should return valid JSON.
fn extract_json_from_response(raw: &str) -> Result<String, OrchestratorError> {
    let trimmed = raw.trim();

    // Case 1: already pure JSON
    if trimmed.starts_with('{') {
        return Ok(trimmed.to_string());
    }

    // Case 2: markdown code fence with language tag (```json ... ```)
    if let Some(json) = extract_code_fence(trimmed, Some("json")) {
        return Ok(json);
    }

    // Case 3: markdown code fence without language tag (``` ... ```)
    if let Some(json) = extract_code_fence(trimmed, None) {
        // Only accept if it starts with `{` (plan/replan JSON)
        if json.trim().starts_with('{') {
            return Ok(json);
        }
    }

    Err(OrchestratorError::InvalidPlanJson(
        "LLM response does not contain valid JSON. Expected a JSON object or a markdown code fence with JSON content.".into(),
    ))
}

/// Extract content from a markdown code fence.
fn extract_code_fence(input: &str, lang: Option<&str>) -> Option<String> {
    let opening = if let Some(l) = lang {
        format!("```{}", l)
    } else {
        "```".to_string()
    };

    let start = input.find(&opening)?;
    // Skip past the opening fence line
    let content_start = input[start..].find('\n')?;
    let content_start = start + content_start + 1;

    // Find closing fence
    let closing = input[content_start..].find("```")?;
    let content = input[content_start..content_start + closing].trim();

    Some(content.to_string())
}

/// Extract an optional string array field from a JSON object, returning
/// an empty Vec if the field is missing. Validates that the field, if present,
/// is an array of strings.
fn string_array_field(
    obj: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    index: usize,
    context: &str,
) -> Result<Vec<String>, OrchestratorError> {
    match obj.get(field) {
        None => Ok(Vec::new()),
        Some(serde_json::Value::Array(arr)) => {
            let mut result = Vec::with_capacity(arr.len());
            for (j, item) in arr.iter().enumerate() {
                match item.as_str() {
                    Some(s) => result.push(s.to_string()),
                    None => {
                        return Err(OrchestratorError::PlanSchemaValidation(format!(
                            "{context}[{index}].{field}[{j}] must be a string"
                        )));
                    }
                }
            }
            Ok(result)
        }
        Some(_) => Err(OrchestratorError::PlanSchemaValidation(format!(
            "{context}[{index}].{field} must be an array of strings"
        ))),
    }
}

/// Extract an optional string array field from the top-level JSON value.
fn string_array_field_root(
    value: &serde_json::Value,
    field: &str,
) -> Result<Vec<String>, OrchestratorError> {
    match value.get(field) {
        None => Ok(Vec::new()),
        Some(serde_json::Value::Array(arr)) => {
            let mut result = Vec::with_capacity(arr.len());
            for (j, item) in arr.iter().enumerate() {
                match item.as_str() {
                    Some(s) => result.push(s.to_string()),
                    None => {
                        return Err(OrchestratorError::PlanSchemaValidation(format!(
                            "{field}[{j}] must be a string"
                        )));
                    }
                }
            }
            Ok(result)
        }
        Some(_) => Err(OrchestratorError::PlanSchemaValidation(format!(
            "{field} must be an array of strings"
        ))),
    }
}

/// Check for circular dependencies in the subtask graph using DFS cycle detection.
fn has_circular_dependency(subtasks: &[Subtask]) -> bool {
    use std::collections::HashSet;

    let ids: Vec<&str> = subtasks.iter().map(|s| s.id.as_str()).collect();
    let mut visited: HashSet<&str> = HashSet::new();
    let mut rec_stack: HashSet<&str> = HashSet::new();

    fn dfs<'a>(
        id: &'a str,
        subtasks_by_id: &std::collections::HashMap<&str, &'a Subtask>,
        visited: &mut HashSet<&'a str>,
        rec_stack: &mut HashSet<&'a str>,
    ) -> bool {
        if rec_stack.contains(id) {
            return true; // cycle found
        }
        if visited.contains(id) {
            return false;
        }
        visited.insert(id);
        rec_stack.insert(id);

        if let Some(st) = subtasks_by_id.get(id) {
            for dep in &st.depends_on {
                if dfs(dep.as_str(), subtasks_by_id, visited, rec_stack) {
                    return true;
                }
            }
        }

        rec_stack.remove(id);
        false
    }

    let subtasks_by_id: std::collections::HashMap<&str, &Subtask> =
        subtasks.iter().map(|s| (s.id.as_str(), s)).collect();

    for id in &ids {
        if dfs(*id, &subtasks_by_id, &mut visited, &mut rec_stack) {
            return true;
        }
    }
    false
}

// ── Path Safety ───────────────────────────────────────────────────────────────

/// Check whether a path string is a safe relative path.
///
/// Returns `false` for:
/// - Empty or whitespace-only strings
/// - Absolute paths (starting with `/` or drive letters like `C:\`)
/// - Paths containing `..` traversal components (on either `/` or `\`)
///
/// Returns `true` for valid relative paths.
pub fn is_safe_relative_path(entry: &str) -> bool {
    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Reject absolute paths
    let is_absolute = trimmed.starts_with('/')
        || (trimmed.len() >= 3
            && trimmed.as_bytes()[1] == b':'
            && (trimmed.as_bytes()[2] == b'\\' || trimmed.as_bytes()[2] == b'/'));
    if is_absolute {
        return false;
    }
    // Reject path traversal
    let has_traversal = trimmed.split('/').any(|c| c == "..")
        || trimmed.split('\\').any(|c| c == "..");
    if has_traversal {
        return false;
    }
    true
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_plan_valid() {
        let raw = r#"```json
        {
            "goal": "Add authentication module",
            "assumptions": ["Express.js project"],
            "subtasks": [
                {
                    "id": "task-1",
                    "title": "Create auth middleware",
                    "description": "Implement JWT auth middleware",
                    "allowed_files": ["src/auth.ts"],
                    "suggested_context_files": ["src/app.ts"],
                    "constraints": ["Do not modify existing routes"],
                    "test_commands": ["npm test"],
                    "acceptance_criteria": ["Auth middleware passes unit tests"],
                    "depends_on": []
                },
                {
                    "id": "task-2",
                    "title": "Add login endpoint",
                    "description": "Create POST /login endpoint",
                    "allowed_files": ["src/routes/login.ts"],
                    "test_commands": ["npm test", "tsc --noEmit"],
                    "acceptance_criteria": ["Login endpoint works"],
                    "depends_on": ["task-1"]
                }
            ],
            "global_constraints": ["No database changes"],
            "completion_definition": ["All tests pass"]
        }
        ```"#;

        let plan = validate_plan_contract(raw).expect("plan should validate");
        assert_eq!(plan.goal, "Add authentication module");
        assert_eq!(plan.subtasks.len(), 2);
        assert_eq!(plan.subtasks[0].id, "task-1");
        assert_eq!(plan.subtasks[1].depends_on, vec!["task-1".to_string()]);
    }

    #[test]
    fn test_validate_plan_pure_json() {
        let raw = r#"{"goal":"Fix typo","subtasks":[{"id":"t1","title":"Fix","description":"Fix typo in README","allowed_files":["README.md"],"test_commands":[],"acceptance_criteria":[],"depends_on":[]}]}"#;

        let plan = validate_plan_contract(raw).expect("plan should validate");
        assert_eq!(plan.goal, "Fix typo");
        assert_eq!(plan.subtasks.len(), 1);
    }

    #[test]
    fn test_validate_plan_missing_goal() {
        let raw = r#"{"subtasks":[{"id":"t1","title":"Test","description":"Desc"}]}"#;
        let err = validate_plan_contract(raw).unwrap_err();
        match err {
            OrchestratorError::PlanSchemaValidation(msg) => {
                assert!(msg.contains("goal"), "Error should mention missing goal: {msg}");
            }
            other => panic!("Expected PlanSchemaValidation, got: {other}"),
        }
    }

    #[test]
    fn test_validate_plan_empty_subtasks() {
        let raw = r#"{"goal":"Do thing","subtasks":[]}"#;
        let err = validate_plan_contract(raw).unwrap_err();
        match err {
            OrchestratorError::PlanSchemaValidation(msg) => {
                assert!(msg.contains("empty"), "Error should mention empty subtasks: {msg}");
            }
            other => panic!("Expected PlanSchemaValidation, got: {other}"),
        }
    }

    #[test]
    fn test_validate_plan_missing_subtask_id() {
        let raw = r#"{"goal":"X","subtasks":[{"title":"Y","description":"Z"}]}"#;
        let err = validate_plan_contract(raw).unwrap_err();
        match err {
            OrchestratorError::PlanSchemaValidation(msg) => {
                assert!(msg.contains("'id'"), "Error should mention missing id: {msg}");
            }
            other => panic!("Expected PlanSchemaValidation, got: {other}"),
        }
    }

    #[test]
    fn test_validate_plan_circular_dependency() {
        let raw = r#"{"goal":"X","subtasks":[
            {"id":"a","title":"A","description":"A","depends_on":["b"]},
            {"id":"b","title":"B","description":"B","depends_on":["a"]}
        ]}"#;
        let err = validate_plan_contract(raw).unwrap_err();
        match err {
            OrchestratorError::PlanSchemaValidation(msg) => {
                assert!(msg.contains("circular"), "Error should mention circular deps: {msg}");
            }
            other => panic!("Expected PlanSchemaValidation, got: {other}"),
        }
    }

    #[test]
    fn test_validate_plan_invalid_depends_on_reference() {
        let raw = r#"{"goal":"X","subtasks":[
            {"id":"a","title":"A","description":"A","depends_on":["nonexistent"]}
        ]}"#;
        let err = validate_plan_contract(raw).unwrap_err();
        match err {
            OrchestratorError::PlanSchemaValidation(msg) => {
                assert!(msg.contains("nonexistent"), "Error should mention bad reference: {msg}");
            }
            other => panic!("Expected PlanSchemaValidation, got: {other}"),
        }
    }

    #[test]
    fn test_validate_replan_valid() {
        let raw = r#"{
            "reason": "Scope violation",
            "failed_subtask_id": "task-1",
            "failure_summary": ["Executor changed files outside scope"],
            "revised_subtask": {
                "id": "task-1b",
                "title": "Fix auth with narrower scope",
                "allowed_files": ["src/auth.ts"],
                "constraints": ["Stay within allowed files"],
                "test_commands": ["npm test"],
                "acceptance_criteria": ["Tests pass"]
            }
        }"#;

        let req = validate_replan_contract(raw).expect("replan should validate");
        assert_eq!(req.reason, "Scope violation");
        assert_eq!(req.failed_subtask_id, "task-1");
        assert_eq!(req.revised_subtask.id, "task-1b");
    }

    #[test]
    fn test_validate_replan_missing_reason() {
        let raw = r#"{"failed_subtask_id":"t1","revised_subtask":{"id":"t1b","title":"X"}}"#;
        let err = validate_replan_contract(raw).unwrap_err();
        match err {
            OrchestratorError::PlanSchemaValidation(msg) => {
                assert!(msg.contains("reason"), "Error should mention missing reason: {msg}");
            }
            other => panic!("Expected PlanSchemaValidation, got: {other}"),
        }
    }

    #[test]
    fn test_validate_execution_result_ok() {
        let result = super::super::types::ExecutionResult {
            subtask_id: "task-1".into(),
            pi_completed: true,
            files_touched: vec!["src/auth.ts".into()],
            files_outside_scope: vec![],
            pi_summary: "Done".into(),
            tool_calls_made: 5,
            turns_taken: 2,
            needs_replan: false,
            replan_reason: None,
            git_diff_applied: false,
        };
        validate_execution_result(&result).expect("should validate");
    }

    #[test]
    fn test_validate_execution_result_empty_id() {
        let result = super::super::types::ExecutionResult {
            subtask_id: String::new(),
            pi_completed: true,
            files_touched: vec![],
            files_outside_scope: vec![],
            pi_summary: "Done".into(),
            tool_calls_made: 0,
            turns_taken: 0,
            needs_replan: false,
            replan_reason: None,
            git_diff_applied: false,
        };
        let err = validate_execution_result(&result).unwrap_err();
        match err {
            OrchestratorError::PlanSchemaValidation(msg) => {
                assert!(msg.contains("subtask_id"), "Error should mention subtask_id: {msg}");
            }
            other => panic!("Expected PlanSchemaValidation, got: {other}"),
        }
    }

    #[test]
    fn test_extract_json_from_response_plain_json() {
        let raw = r#"{"goal":"X","subtasks":[]}"#;
        // This would fail full validation (empty subtasks) but extraction works
        let json = extract_json_from_response(raw).unwrap();
        assert!(json.starts_with('{'));
    }

    #[test]
    fn test_extract_json_from_response_code_fence() {
        let raw = "Here's the plan:\n```json\n{\"goal\":\"X\",\"subtasks\":[]}\n```\nLet me know!";
        let json = extract_json_from_response(raw).unwrap();
        assert!(json.contains("\"goal\""));
    }

    #[test]
    fn test_extract_json_from_response_no_json() {
        let raw = "I don't have a plan for that.";
        let err = extract_json_from_response(raw).unwrap_err();
        match err {
            OrchestratorError::InvalidPlanJson(msg) => {
                assert!(msg.contains("does not contain valid JSON"), "Error: {msg}");
            }
            other => panic!("Expected InvalidPlanJson, got: {other}"),
        }
    }

    #[test]
    fn test_validate_plan_arrays_optional() {
        // Subtask without optional array fields should still validate
        let raw = r#"{"goal":"G","subtasks":[{"id":"t1","title":"T","description":"D"}]}"#;
        let plan = validate_plan_contract(raw).expect("should validate with missing optional fields");
        assert!(plan.assumptions.is_empty());
        assert!(plan.subtasks[0].allowed_files.is_empty());
    }
}