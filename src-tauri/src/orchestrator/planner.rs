//! Planning model adapter.
//!
//! Calls Aelvyril's gateway forwarding logic so the request passes
//! through the full PII pipeline automatically (PII detection,
//! pseudonymization, token usage recording, audit logging).
//!
//! Currently uses HTTP loopback (same gateway endpoint the frontend uses).
//! TODO(v2): Switch to a direct internal call (`gateway::forward` wrapper)
//! to avoid the serialize→HTTP→deserialize round-trip overhead.

use super::contracts;
use super::errors::OrchestratorError;
use super::types::{
    OrchestratorSettings, Plan, PlanningContext, ReplanRequest, Subtask,
    ValidationResult,
};

/// System prompt that instructs the planning model to return a valid plan JSON.
const PLAN_SYSTEM_PROMPT: &str = r#"You are a coding task planner. Given a user request and repo context, produce a JSON plan.

Return ONLY a JSON object matching this schema (no markdown, no explanation):
{
  "goal": "string — the overall goal",
  "assumptions": ["string — assumptions about the codebase"],
  "subtasks": [
    {
      "id": "task-1",
      "title": "string — short title",
      "description": "string — clear instructions for an autonomous coding executor",
      "allowed_files": ["path — files the executor may modify"],
      "suggested_context_files": ["path — files the executor should read for context"],
      "constraints": ["string — constraints on the implementation"],
      "test_commands": ["string — commands to validate the change (e.g. 'cargo check', 'npm test')"],
      "acceptance_criteria": ["string — concrete criteria for success"],
      "depends_on": ["task-id — subtask dependencies"]
    }
  ],
  "global_constraints": ["string — constraints that apply to all subtasks"],
  "completion_definition": ["string — criteria for overall task completion"]
}

Rules:
- Each subtask must have a unique id (task-1, task-2, ...)
- allowed_files must list every file the executor may write to
- test_commands must be simple commands (no shell operators like &&, |, ;)
- acceptance_criteria must be concrete and verifiable
- Keep subtasks focused — max 6 files per subtask
- If the task is simple enough for one step, return a single subtask"#;

/// System prompt for replanning after a subtask failure.
fn build_replan_system_prompt() -> String {
    format!(
        r#"You are a coding task replanner. A subtask failed. Given the failure context, produce a revised plan.

Return ONLY a JSON object matching this schema (no markdown, no explanation):
{{
  "reason": "string — why replanning is needed",
  "failed_subtask_id": "string — the ID of the failed subtask",
  "failure_summary": ["string — summary of what went wrong"],
  "revised_subtask": {{
    "id": "task-N — new subtask ID",
    "title": "string — short title",
    "allowed_files": ["path"],
    "constraints": ["string"],
    "test_commands": ["string"],
    "acceptance_criteria": ["string"]
  }}
}}"#
    )
}

/// Build the user message for the planning model.
fn build_planning_user_message(task: &str, context: &PlanningContext) -> String {
    let mut msg = String::new();
    msg.push_str(&format!("TASK: {task}\n\n"));

    if !context.repo_tree_summary.is_empty() {
        msg.push_str("REPO CONTEXT:\n");
        msg.push_str(&context.repo_tree_summary);
        msg.push('\n');
    }

    if !context.entry_points.is_empty() {
        msg.push_str("\nENTRY POINTS:\n");
        for ep in &context.entry_points {
            msg.push_str(&format!("- {ep}\n"));
        }
    }

    if !context.current_errors.is_empty() {
        msg.push_str("\nCURRENT ERRORS:\n");
        for err in &context.current_errors {
            msg.push_str(&format!("- {err}\n"));
        }
    }

    if !context.user_constraints.is_empty() {
        msg.push_str("\nUSER CONSTRAINTS:\n");
        for c in &context.user_constraints {
            msg.push_str(&format!("- {c}\n"));
        }
    }

    if !context.previous_failures.is_empty() {
        msg.push_str("\nPREVIOUS FAILURES (fix these):\n");
        for f in &context.previous_failures {
            msg.push_str(&format!("- {f}\n"));
        }
    }

    msg
}

/// Build the user message for replanning.
fn build_replan_user_message(
    plan: &Plan,
    subtask: &Subtask,
    validation: &ValidationResult,
    context: &PlanningContext,
) -> String {
    let mut msg = String::new();
    msg.push_str(&format!(
        "ORIGINAL GOAL: {}\n\n",
        plan.goal
    ));
    msg.push_str(&format!("FAILED SUBTASK: {} — {}\n", subtask.id, subtask.title));
    msg.push_str(&format!(
        "DESCRIPTION: {}\n\n",
        subtask.description
    ));

    if !validation.errors.is_empty() {
        msg.push_str("VALIDATION ERRORS:\n");
        for e in &validation.errors {
            msg.push_str(&format!("- {e}\n"));
        }
        msg.push('\n');
    }

    if !context.previous_failures.is_empty() {
        msg.push_str("PAST FAILURES:\n");
        for f in &context.previous_failures {
            msg.push_str(&format!("- {f}\n"));
        }
        msg.push('\n');
    }

    msg.push_str("Remaining subtasks:\n");
    for st in &plan.subtasks {
        let status_str = format!("{:?}", st.status);
        msg.push_str(&format!(
            "- {} ({}): {} [{}]\n",
            st.id, st.title, st.description, status_str
        ));
    }

    msg
}

/// Make a non-streaming chat completion call through the gateway.
///
/// TODO(v2): The plan doc specifies calling `gateway::forward::forward_chat_completion()`
/// directly (same process) to avoid HTTP overhead. That wrapper doesn't exist yet —
/// the gateway module exposes `forward_and_rehydrate()` which requires Axum-specific
/// `ForwardContext` and `LatencyBuilder` types not suitable for internal callers.
/// For now, we use HTTP loopback which still runs PII detection/pseudonymization
/// and records token usage/audit. When a `forward_chat_completion(app_state, model, messages)`
/// convenience wrapper is added to the gateway module, switch to that.
async fn call_gateway(
    app_state: &crate::state::SharedState,
    model: &str,
    system_prompt: &str,
    user_message: &str,
) -> Result<String, OrchestratorError> {
    let messages = vec![
        serde_json::json!({ "role": "system", "content": system_prompt }),
        serde_json::json!({ "role": "user", "content": user_message }),
    ];

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });

    // Read gateway port from shared state
    let port = {
        let app = app_state.read().await;
        app.gateway_port
    };
    let url = format!("http://localhost:{port}/v1/chat/completions");

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| OrchestratorError::PlanningModelFailed(format!("HTTP request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(OrchestratorError::PlanningModelFailed(
            format!("Gateway returned {status}: {text}"),
        ));
    }

    let response_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| OrchestratorError::PlanningModelFailed(format!("Invalid JSON response: {e}")))?;

    // Extract content from OpenAI-compatible response
    let content = response_json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| {
            OrchestratorError::PlanningModelFailed(
                "Response missing choices[0].message.content".into(),
            )
        })?;

    Ok(content.to_string())
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Create a plan from a user request and repo context.
///
/// Calls the planning model through Aelvyril's gateway (HTTP loopback
/// until a direct internal-call wrapper is available; see call_gateway TODO).
/// The response goes through PII scrubbing automatically.
pub async fn create_plan(
    task: &str,
    context: &PlanningContext,
    config: &OrchestratorSettings,
    app_state: &crate::state::SharedState,
) -> Result<Plan, OrchestratorError> {
    let user_message = build_planning_user_message(task, context);
    let raw_response = call_gateway(
        app_state,
        &config.planning_model,
        PLAN_SYSTEM_PROMPT,
        &user_message,
    )
    .await?;

    let mut plan = contracts::validate_plan_contract(&raw_response)?;
    // task_id is set by the caller (state machine) — clear it here
    plan.task_id.clear();
    Ok(plan)
}

/// Produce a revised plan after a subtask failure.
pub async fn replan(
    plan: &Plan,
    failed_subtask: &Subtask,
    validation: &ValidationResult,
    context: &PlanningContext,
    config: &OrchestratorSettings,
    app_state: &crate::state::SharedState,
) -> Result<ReplanRequest, OrchestratorError> {
    let user_message = build_replan_user_message(plan, failed_subtask, validation, context);
    let raw_response = call_gateway(
        app_state,
        &config.planning_model,
        &build_replan_system_prompt(),
        &user_message,
    )
    .await?;

    contracts::validate_replan_contract(&raw_response)
}

// ── Decision helpers ─────────────────────────────────────────────────────────

/// Decide whether a task needs planning or can go straight to execution.
///
/// Heuristics from the plan:
/// - mentions multiple files → true
/// - contains planning keywords → true
/// - > 200 chars → true
/// - is a question → false
/// - specifies exact file + line → false
/// - default for short tasks → false
pub fn needs_planning(task: &str) -> bool {
    let lower = task.to_lowercase();

    // Questions don't need planning
    if lower.starts_with("what ")
        || lower.starts_with("how ")
        || lower.starts_with("why ")
        || lower.starts_with("where ")
        || lower.starts_with("when ")
        || lower.starts_with("who ")
        || lower.contains("does ")
        || lower.contains("is there")
    {
        // But if it also mentions making changes, it's a task, not a question
        if !lower.contains("add")
            && !lower.contains("create")
            && !lower.contains("fix")
            && !lower.contains("refactor")
            && !lower.contains("implement")
            && !lower.contains("update")
            && !lower.contains("change")
            && !lower.contains("modify")
        {
            return false;
        }
    }

    // Planning keywords
    let planning_keywords = ["design", "plan", "architecture", "refactor", "break down", "approach"];
    if planning_keywords.iter().any(|k| lower.contains(k)) {
        return true;
    }

    // Multiple files mentioned (heuristic: path-like patterns)
    let path_count = lower.split_whitespace().filter(|w| {
        w.contains('/') || w.contains(".rs") || w.contains(".ts") || w.contains(".js") || w.contains(".py")
    }).count();
    if path_count > 1 {
        return true;
    }

    // Long tasks are likely complex
    if task.len() > 200 {
        return true;
    }

    false
}

/// Check if a task is a simple question (not a coding task).
pub fn is_simple_question(task: &str) -> bool {
    let owned = task.to_lowercase();
    let lower = owned.trim();

    // Questions
    if lower.starts_with("what ")
        || lower.starts_with("how ")
        || lower.starts_with("why ")
        || lower.starts_with("where ")
        || lower.starts_with("when ")
        || lower.starts_with("who ")
        || lower.starts_with("explain ")
        || lower.starts_with("describe ")
        || lower.starts_with("tell me ")
    {
        // Check it's not asking for code generation
        let code_verbs = ["add", "create", "fix", "implement", "build", "write", "refactor", "update"];
        if !code_verbs.iter().any(|v| lower.contains(v)) {
            return true;
        }
    }

    // Ends with ? and is short
    lower.ends_with('?') && task.len() < 150
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_needs_planning_refactor() {
        assert!(needs_planning("refactor the auth module to use JWT tokens"));
    }

    #[test]
    fn test_needs_planning_multiple_files() {
        assert!(needs_planning("update src/auth.ts and src/middleware.ts to use the new session API"));
    }

    #[test]
    fn test_needs_planning_long_task() {
        let task = "a".repeat(250);
        assert!(needs_planning(&task));
    }

    #[test]
    fn test_no_planning_simple_fix() {
        assert!(!needs_planning("fix typo in README.md line 42"));
    }

    #[test]
    fn test_no_planning_question() {
        assert!(!needs_planning("what does the auth middleware do?"));
    }

    #[test]
    fn test_is_simple_question() {
        assert!(is_simple_question("what is the gateway port?"));
        assert!(is_simple_question("how does PII detection work?"));
    }

    #[test]
    fn test_not_simple_question_with_code() {
        assert!(!is_simple_question("fix the bug in auth.ts"));
    }
}
