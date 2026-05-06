# Aelvyril Orchestrator — Plan and Execute Coding Agent

## Two separate integrations

```
1. pi as external tool (onboarding detection)
   - User runs pi directly in terminal
   - pi points at Aelvyril's gateway for privacy
   - Change: tool_detection.rs + onboarding.rs
   - NOTE: tool_detection.rs currently detects Cursor, VS Code, Claude CLI.
     Add detect_pi() following the same pattern (check `which pi` + version check).

2. Orchestrator inside Aelvyril (this plan)
   - Aelvyril runs its own plan-and-execute loop
   - Planning Model = LLM call through Aelvyril's gateway (PII scrubbed automatically)
   - Executor = pi spawned via RPC subprocess
   - pi handles all repo scanning, file ops, shell commands
   - Everything logged to audit
```

## Why pi as the executor

- pi already does file discovery, repo scanning, shell execution
- pi auto-runs everything by default (no permission gates)
- pi has RPC mode for programmatic subprocess integration
- The orchestrator does not need to reinvent file tools — pi has them
- Aelvyril's PII layer still protects everything because pi's LLM calls go through the gateway

## Integration method

Pi's SDK is TypeScript only. Aelvyril is Rust/Tauri. The integration path is:

```
Rust spawns `pi --mode rpc` as a tokio subprocess
  → Sends JSON commands via stdin (one JSON object per line, LF-delimited)
  → Reads JSONL events via stdout (async line-based reader)
  → Parses events for tool calls, file changes, completion
  → Sends abort command then kills subprocess on timeout or max tool calls
```

Pi RPC protocol reference: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/rpc.md

**IMPORTANT: All RPC commands require an `id` field** to correlate responses with requests:
```json
{"id": "req-1", "type": "prompt", "message": "..."}
```
The orchestrator must generate unique IDs per command and match `response` events by `id` to confirm acceptance.

Key RPC events the orchestrator consumes:

| Event | Use |
|-------|-----|
| `agent_start` | Know pi began processing |
| `tool_execution_end` | Track which files pi touched (contains tool name + args) |
| `tool_execution_start` | Detect tool name early for scope pre-check (optional optimization) |
| `turn_end` | Detect completion of one reasoning cycle |
| `agent_end` | Final completion, contains all messages |
| `message_update` | Stream text deltas (v2: forward to UI for live progress) |

Key RPC commands the orchestrator sends:

| Command | Use |
|---------|-----|
| `{"id": "req-N", "type": "prompt", "message": "..."}` | Send subtask prompt |
| `{"id": "req-N", "type": "steer", "message": "..."}` | Interrupt if pi goes off-scope |
| `{"id": "req-N", "type": "abort"}` | Gracefully abort current agent operation |

**Note:** There is no `kill` command in pi's RPC protocol. Use `abort` to stop the agent gracefully, then `child.kill()` (OS-level) if the process doesn't exit. The EXECUTE state transitions use this pattern: send `abort` → wait briefly → `child.kill()` if still alive.

---

## Architecture overview

```
User request (Aelvyril UI)
  ↓
INTAKE — classify: simple question vs coding task
  ├─ Simple question → normal gateway (skip orchestrator)
  └─ Coding task → orchestrator
       ↓
    pre-flight checks (gateway running, providers set, pi installed, pi configured)
       ↓
    needs_planning?
       ├─ No → SELECT_SUBTASK (auto single-step plan)
       └─ Yes → PLAN
                   ↓
                Planning Model (LLM via Aelvyril gateway)
                   ↓
                PARSE_PLAN (validate JSON schema)
                   ↓
                SELECT_SUBTASK
                   ↓
                EXECUTE (spawn pi --mode rpc)
                   ↓
                PARSE_EXECUTION (check scope, extract results)
                   ↓
                VALIDATE (run test_commands in user shell, log to audit)
                   ↓
                COMPLETE_SUBTASK or REPLAN or BLOCKED
                   ↓
                Done → return summary
```

### State management

The orchestrator maintains its own state separate from `AppState`:

```
Tauri manages:
  Arc<RwLock<AppState>>          -- existing app state (gateway, providers, settings, audit, etc.)
  Arc<RwLock<OrchestratorState>> -- orchestrator state (active tasks, plans, execution results)
```

**Why separate?** `AppState` is `Arc<RwLock<...>>` shared across all Tauri commands. A long-running orchestrator task holding a write lock would block all other commands (settings, audit, sessions). The orchestrator gets its own managed resource so it never contends with the rest of the app.

Both states are registered in `lib.rs`:
```rust
.manage(Arc::new(RwLock::new(AppState::new())))
.manage(Arc::new(RwLock::new(OrchestratorState::new())))
```

---

## State machine

### States

```
INTAKE
PLAN
PARSE_PLAN
SELECT_SUBTASK
EXECUTE
PARSE_EXECUTION
VALIDATE
COMPLETE_SUBTASK
REPLAN
DONE
BLOCKED
```

### Transitions

```
INTAKE
  ├─ pre-flight fails (gateway down, no providers, pi missing, pi misconfigured)
  │   → BLOCKED (show user what's missing)
  ├─ simple question (not a coding task)
  │   → DONE (route to normal gateway path, do not enter orchestrator)
  ├─ needs_planning(task) == true
  │   → PLAN
  └─ else
      → SELECT_SUBTASK (auto-generated single-step plan)

PLAN
  ├─ planning_model returns response
  │   → PARSE_PLAN
  └─ planning_model fails (network, timeout, provider error)
      ├─ retry_count < 2
      │   → PLAN (with error feedback in prompt)
      └─ else
          → BLOCKED ("Planning model failed, provide manual guidance?")

PARSE_PLAN
  ├─ valid JSON matching plan schema, has subtasks
  │   → SELECT_SUBTASK
  └─ invalid JSON or schema mismatch
      ├─ retry_count < 2
      │   → PLAN (with schema error in prompt: "return valid JSON matching this schema: ...")
      └─ else
          → BLOCKED ("Planning model returning invalid output")

SELECT_SUBTASK
  ├─ has next executable subtask (dependencies met)
  │   → EXECUTE
  └─ no more subtasks
      → DONE

EXECUTE
  ├─ pi RPC process spawned successfully, prompt sent (with id field)
  │   → monitor events, wait for agent_end
  ├─ pi completes (agent_end received)
  │   → PARSE_EXECUTION
  ├─ pi process crashes or exits unexpectedly
  │   → BLOCKED (show crash log, ask user: retry or cancel?)
  ├─ pi exceeds max tool calls (default 30)
  │   → send abort command, kill process, REPLAN ("executor exceeded tool call limit")
  └─ pi exceeds timeout (default 10 min)
      → send abort command, kill process, REPLAN ("executor timed out")

PARSE_EXECUTION
  ├─ pi completed, files_touched within allowed_files
  │   → VALIDATE
  ├─ pi completed, but touched files outside allowed_files
  │   → fail subtask, REPLAN ("executor exceeded file scope: [files]")
  └─ pi completed but output is unclear (no tool calls made, no files changed)
      ├─ retry_count < 2
      │   → EXECUTE (with clarification in prompt)
      └─ else
          → REPLAN ("executor produced no output")

VALIDATE
  ├─ all test_commands pass
  │   → COMPLETE_SUBTASK
  ├─ test_commands fail, retry_count < 2
  │   → EXECUTE (augment prompt with error output)
  └─ test_commands fail, retries exhausted
      → REPLAN (include failure logs)

COMPLETE_SUBTASK
  ├─ more subtasks remain
  │   → SELECT_SUBTASK
  └─ all subtasks done
      → DONE

REPLAN
  ├─ planning_model returns valid revised plan
  │   → SELECT_SUBTASK
  └─ planning_model can not recover
      → BLOCKED ("Replan failed, provide manual guidance?")

BLOCKED
  ├─ user provides manual input
  │   → PLAN (incorporate user guidance)
  └─ user cancels
      → DONE (partial, return what was completed)
```

---

## Decision rules

### Send to Planning Model when:
- Task spans multiple files or systems
- User says "design", "plan", "architecture", "break down", "approach", "refactor"
- Repo area is unclear
- Previous execution failed twice
- Executor touched files outside allowed scope
- Acceptance criteria are missing

### Send to Executor Model (pi) when:
- There is one active subtask
- Allowed files are known
- Expected output is concrete
- Validation commands are available
- The change can be attempted without architectural debate

### Skip orchestrator entirely when:
- User asks a simple question ("what does X do?")
- Task is a single typo fix or trivial one-liner the user already specified
- User is not requesting code changes

### Needs planning heuristic:
```
needs_planning(task) → bool:
  - task mentions multiple files → true
  - task contains "design", "plan", "architecture", "refactor", "break down" → true
  - task is > 200 chars → true (likely complex)
  - task is a question ("what does X do?") → false
  - task specifies exact file + line ("fix auth.ts line 42") → false
  - default for short tasks → false
```

---

## Contracts

### Planning contract

```json
{
  "goal": "string",
  "assumptions": ["string"],
  "subtasks": [
    {
      "id": "task-1",
      "title": "string",
      "description": "string — clear instructions for pi",
      "allowed_files": ["path"],
      "suggested_context_files": ["path"],
      "constraints": ["string"],
      "test_commands": ["string"],
      "acceptance_criteria": ["string"],
      "depends_on": []
    }
  ],
  "global_constraints": ["string"],
  "completion_definition": ["string"]
}
```

### Execution contract (fixed)

Pi is autonomous — it does not return structured diffs. The orchestrator detects results by monitoring pi's tool_execution events.

```json
{
  "subtask_id": "task-1",
  "pi_completed": true,
  "files_touched": ["src/auth.ts"],
  "files_outside_scope": [],
  "pi_summary": "string — pi's final text message describing what it did",
  "tool_calls_made": 12,
  "turns_taken": 3,
  "needs_replan": false,
  "replan_reason": null
}
```

`files_touched` is extracted from pi's `tool_execution_end` events where the tool was `write` or `edit`.

`files_outside_scope` is computed by diffing `files_touched` against the subtask's `allowed_files`.

**Known limitation:** pi can also modify files via the `bash` tool (e.g., `sed`, `mv`, `git checkout`, `npm install`). These changes are NOT captured by `tool_execution_end` file extraction. For v1, this is accepted as a known gap. Mitigation: the validator's `test_commands` will catch many regressions, and `git diff` can be run post-execution as a full-file-change audit if needed.

### Validation contract

```json
{
  "subtask_id": "task-1",
  "status": "pass|fail",
  "commands_run": ["npm test", "tsc --noEmit"],
  "intended_commands": ["npm test", "tsc --noEmit", "npm run build"],
  "errors": ["string"],
  "notes": ["string"]
}
```

`intended_commands` always contains the full `test_commands` list from the subtask, even when validation fails partway through. This gives the replan model complete context about what was supposed to run.

### Replan contract

```json
{
  "reason": "string",
  "failed_subtask_id": "task-1",
  "failure_summary": ["string"],
  "revised_subtask": {
    "id": "task-1b",
    "title": "string",
    "allowed_files": ["path"],
    "constraints": ["string"],
    "test_commands": ["string"],
    "acceptance_criteria": ["string"]
  }
}
```

---

## Context builder

### Planning context (broad)

- User goal
- Repo tree summary (built via lightweight function, NOT a pi subprocess call — see note below)
- Entrypoints
- Relevant modules
- Current errors if any
- Constraints from user
- Previous failed attempts

**Repo scan implementation:** Do NOT spawn a pi subprocess just to scan the repo. Instead, use a lightweight Rust function that walks the directory tree, identifies key files (package.json, Cargo.toml, entry points, src/ structure), and builds a summary string. This avoids the ~300-500ms Node.js cold start for a trivial task. Only spawn pi for actual code execution.

```rust
const MAX_SUMMARY_CHARS: usize = 2000;
const MAX_WALK_DEPTH: usize = 4;

fn build_repo_tree_summary(repo_path: &Path) -> String {
    // Walk directory, identify:
    //   - Language (by file extensions)
    //   - Entry points (main.rs, main.ts, index.ts, etc.)
    //   - Test directories
    //   - Config files (Cargo.toml, package.json, tsconfig.json)
    //   - Key module directories
    // Skips: node_modules, .git, target, dist, build, .next, __pycache__
    // Max depth: 4 levels to avoid scanning vendored/generated code.
    // Output capped at 2000 chars — if exceeded, truncate with "... (N more files)".

    const SKIP_DIRS: &[&str] = &[
        "node_modules", ".git", "target", "dist", "build", ".next",
        "__pycache__", ".venv", "vendor", ".svelte-kit",
    ];

    fn walk(dir: &Path, depth: usize, out: &mut String, remaining: &mut usize) {
        if depth > MAX_WALK_DEPTH || *remaining == 0 { return; }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        items.sort_by_key(|e| e.file_name());

        for entry in items {
            if *remaining == 0 { return; }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if SKIP_DIRS.contains(&name_str.as_ref()) { continue; }
                let indent = "  ".repeat(depth);
                out.push_str(&format!("{}{}/\n", indent, name_str));
                *remaining = remaining.saturating_sub(indent.len() + name_str.len() + 2);
                walk(&entry.path(), depth + 1, out, remaining);
            } else {
                let indent = "  ".repeat(depth);
                out.push_str(&format!("{}{}\n", indent, name_str));
                *remaining = remaining.saturating_sub(indent.len() + name_str.len() + 1);
            }
        }
    }

    let mut out = String::new();
    let mut remaining = MAX_SUMMARY_CHARS;
    walk(repo_path, 0, &mut out, &mut remaining);

    if remaining == 0 {
        out.push_str("... (truncated)\n");
    }
    out
}
```

### Executor context (narrow, per subtask)

- One subtask only
- Allowed files only
- Exact lint/build/test errors if retrying
- Coding rules
- Required output behavior (not a schema — pi is autonomous)

---

## Executor adapter — pi RPC

```rust
/// Monotonic command ID counter for correlating RPC requests/responses.
/// Prefixed with a per-session UUID so IDs never collide with a previous
/// session's commands if the app restarts while pi is still running.
static COMMAND_ID: AtomicU64 = AtomicU64::new(1);
static SESSION_NONCE: Lazy<String> = Lazy::new(|| {
    uuid::Uuid::new_v4().to_string()[..8].to_string()
});

fn next_command_id() -> String {
    format!("orch-{}-{}", *SESSION_NONCE, COMMAND_ID.fetch_add(1, Ordering::Relaxed))
}

async fn spawn_pi_executor(
    subtask: &Subtask,
    context: &ExecutorContext,
    config: &OrchestratorSettings,
    app_state: &AppState,
) -> Result<PiExecutionResult, OrchestratorError> {
    // Build constrained prompt
    let prompt = format!(
        "SUBTASK: {}\nALLOWED FILES: {}\nCONSTRAINTS: {}\nACCEPTANCE CRITERIA: {}\nDo not touch files outside the allowed list.\n{}",
        subtask.description,
        subtask.allowed_files.join(", "),
        subtask.constraints.join("; "),
        subtask.acceptance_criteria.join("; "),
        if let Some(errors) = &context.previous_errors {
            format!("PREVIOUS ERRORS:\n{}", errors.join("\n"))
        } else {
            String::new()
        }
    );

    // Resolve gateway key — pi must authenticate with Aelvyril's gateway
    let gateway_key = app_state.gateway_key
        .as_ref()
        .ok_or(OrchestratorError::NoGatewayKey)?;

    // Pi has no --api-base CLI flag. Provider routing is configured via ~/.pi/agent/models.json.
    // Pre-flight check #8 ensures an "aelvyril" provider entry exists in models.json pointing
    // at the gateway. This is a one-time setup step (pre-flight writes it if missing).
    //
    // The gateway speaks OpenAI-compatible API, so we use the "aelvyril" provider name
    // registered in models.json with api: "openai-completions".
    let mut child = Command::new("pi")
        .args([
            "--mode", "rpc",
            "--provider", "aelvyril",
            "--model", &config.executor_model,
            // Pass API key via env var instead of CLI arg to avoid leaking in `ps` output.
            // Falls back to --api-key if pi doesn't support env var for this.
            // "--api-key", gateway_key,
        ])
        .env("PI_API_KEY", gateway_key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    // Take ownership of stdin early so we can reliably send abort later.
    // Once taken, it stays alive for the duration of this function.
    let mut stdin = child.stdin.take()
        .ok_or(OrchestratorError::SpawnFailed("no stdin pipe".into()))?;

    // Send prompt with required id field
    let cmd_id = next_command_id();
    let prompt_cmd = serde_json::json!({
        "id": cmd_id,
        "type": "prompt",
        "message": prompt
    });
    write_rpc_command(&mut stdin, &prompt_cmd).await?;

    // Drain stderr in a background task to prevent pipe deadlock.
    // If pi writes >64KB to stderr while we're blocked on stdout, the process
    // would stall without this.
    let stderr_handle = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        if let Some(mut stderr) = stderr_handle {
            let _ = stderr.read_to_string(&mut buf).await;
        }
        buf
    });

    // Read events with timeout and tool call limit
    let mut files_touched = Vec::new();
    let mut tool_calls = 0u32;
    let mut pi_summary = String::new();
    let mut completed = false;

    let timeout = Duration::from_secs(config.executor_timeout_secs);
    let result = tokio::time::timeout(timeout, async {
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).await? == 0 {
                break; // EOF
            }
            let event: serde_json::Value = serde_json::from_str(&line)?;

            match event["type"].as_str() {
                Some("tool_execution_end") => {
                    tool_calls += 1;
                    if tool_calls > config.max_tool_calls {
                        // Graceful abort via owned stdin, then force kill
                        let abort_cmd = serde_json::json!({
                            "id": next_command_id(),
                            "type": "abort"
                        });
                        let _ = write_rpc_command(&mut stdin, &abort_cmd).await;
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        let _ = child.kill().await;
                        return Err(OrchestratorError::ToolCallLimit);
                    }
                    // Extract file path from write/edit tool calls
                    if let Some(file) = extract_file_from_tool_event(&event) {
                        files_touched.push(file);
                    }
                }
                Some("agent_end") => {
                    completed = true;
                    pi_summary = extract_summary_from_messages(&event["messages"]);
                    break;
                }
                _ => {}
            }
        }
        Ok(())
    }).await;

    // Collect stderr output (already drained by background task)
    let stderr_buf = stderr_task.await.unwrap_or_default();

    match result {
        Ok(Ok(())) => {
            if !stderr_buf.is_empty() {
                tracing::debug!("pi stderr (completed): {}", stderr_buf);
            }

            // Check scope — use proper path boundary matching, not prefix.
            // "src" matches "src/main.rs" but NOT "src_backup/main.rs".
            let outside_scope: Vec<_> = files_touched.iter()
                .filter(|f| !subtask.allowed_files.iter().any(|a| {
                    is_path_within(f, a)
                }))
                .cloned()
                .collect();

            Ok(PiExecutionResult {
                subtask_id: subtask.id.clone(),
                pi_completed: completed,
                files_touched,
                files_outside_scope: outside_scope,
                pi_summary,
                tool_calls_made: tool_calls,
                turns_taken: 0, // v1: not tracked; increment on turn_end events in v2
                needs_replan: !outside_scope.is_empty(),
                replan_reason: if !outside_scope.is_empty() {
                    Some(format!("executor exceeded file scope: {:?}", outside_scope))
                } else {
                    None
                },
            })
        }
        Ok(Err(e)) => {
            if !stderr_buf.is_empty() {
                tracing::warn!("pi stderr (error): {}", stderr_buf);
            }
            Err(e)
        }
        Err(_timeout) => {
            // Graceful abort via owned stdin, then force kill
            let abort_cmd = serde_json::json!({
                "id": next_command_id(),
                "type": "abort"
            });
            let _ = write_rpc_command(&mut stdin, &abort_cmd).await;
            tokio::time::sleep(Duration::from_millis(500)).await;
            let _ = child.kill().await;

            if !stderr_buf.is_empty() {
                tracing::warn!("pi stderr (timeout/killed): {}", stderr_buf);
            }
            Err(OrchestratorError::ExecutorTimeout)
        }
    }
}

/// Returns true if `path` is within or equal to `allowed`.
/// "src/" matches "src/main.rs" and "src/utils/helper.rs".
/// "src"  matches "src/main.rs" (treated as directory).
/// "src/main.rs" matches only that exact file.
/// Never matches "../" escapes or sibling prefixes like "src_backup/".
fn is_path_within(path: &str, allowed: &str) -> bool {
    let a = allowed.trim_end_matches('/');
    path == a || path.starts_with(&format!("{}/", a))
}
```

### Cold start cost

Spawning `pi --mode rpc` for each subtask incurs:
- Node.js startup: ~200-500ms
- MCP server initialization: varies by server count
- No context carryover between subtasks (intentional for clean state)

For a 5-subtask plan, that's 5 cold starts. **Accepted tradeoff for v1** — clean state is more valuable than spawn latency. If this becomes a bottleneck, consider:
- Keeping a warm pi process and using `new_session` command between subtasks
- Pre-warming a pi process during the PLAN phase

### Write timeout note

`write_rpc_command` should be wrapped in `tokio::time::timeout` (e.g., 5 seconds) to prevent hanging if pi's stdin pipe is full or broken. Without this, a stalled pi process could block the orchestrator indefinitely:

```rust
async fn write_rpc_command_with_timeout(
    writer: &mut impl AsyncWrite + Unpin,
    cmd: &serde_json::Value,
) -> Result<(), OrchestratorError> {
    tokio::time::timeout(Duration::from_secs(5), write_rpc_command(writer, cmd))
        .await
        .map_err(|_| OrchestratorError::StdinTimeout)?
}
```

### Max files enforcement

The `max_files_per_subtask` config is enforced in PARSE_EXECUTION. If `files_touched.len() > config.max_files_per_subtask`, the subtask is failed and triggers REPLAN even if all files are within `allowed_files`:

```rust
// In PARSE_EXECUTION, after scope check:
if result.files_touched.len() > config.max_files_per_subtask as usize {
    return Err(OrchestratorError::TooManyFiles(
        result.files_touched.len(),
        config.max_files_per_subtask,
    ));
}
```

---

## Validator

Runs test_commands in user's shell after pi completes. Logs to Aelvyril audit.

**Security:** test_commands come from the planning model's output. To prevent command injection (hallucinated or malicious planner), commands are validated against a whitelist before execution:

```rust
/// Built-in allowed test command prefixes. Users can extend via `allowed_test_commands` in settings.
const BUILTIN_ALLOWED_TEST_COMMANDS: &[&str] = &[
    // npm
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run typecheck",
    "npm run check",
    "npm run build",
    // pnpm
    "pnpm test",
    "pnpm run test",
    "pnpm run lint",
    "pnpm run typecheck",
    "pnpm run check",
    "pnpm run build",
    // yarn
    "yarn test",
    "yarn lint",
    "yarn typecheck",
    "yarn check",
    "yarn build",
    // bun
    "bun test",
    "bun run test",
    "bun run lint",
    "bun run typecheck",
    "bun run build",
    // npx
    "npx tsc --noEmit",
    "npx eslint",
    // cargo
    "cargo test",
    "cargo check",
    "cargo clippy",
    "cargo build",
    // python
    "pytest",
    "python -m pytest",
    "python manage.py test",
    // go
    "go test",
    // make
    "make test",
    "make check",
    "make lint",
    "make -C",
];

fn validate_test_command(cmd: &str, extra_allowed: &[String]) -> Result<(), ValidationError> {
    let trimmed = cmd.trim();
    let allowed = BUILTIN_ALLOWED_TEST_COMMANDS.iter().any(|prefix| {
        trimmed.starts_with(prefix)
    }) || extra_allowed.iter().any(|prefix| {
        trimmed.starts_with(prefix.as_str())
    });
    if !allowed {
        return Err(ValidationError::ForbiddenCommand(cmd.to_string()));
    }
    // Reject shell metacharacters that could enable injection.
    // This catches operators, pipes, redirects, command substitution,
    // variable expansion, and newline-based multi-command injection.
    let dangerous = ["&&", "||", "|", ">", ">>", ";", "$", "`", "\n", "\r"];
    for pattern in &dangerous {
        if trimmed.contains(pattern) {
            return Err(ValidationError::ShellOperatorsNotAllowed(
                format!("'{}' contains forbidden pattern '{}'", cmd, pattern.escape_debug())
            ));
        }
    }
    Ok(())
}

async fn run_validation(
    subtask: &Subtask,
    config: &OrchestratorSettings,
) -> ValidationResult {
    let mut commands_run = Vec::new();
    let mut errors = Vec::new();

    for cmd in &subtask.test_commands {
        // SECURITY: Validate command against whitelist (built-in + user-configured)
        if let Err(e) = validate_test_command(cmd, &config.allowed_test_commands) {
            errors.push(format!("Command '{}' rejected: {}", cmd, e));
            return ValidationResult {
                subtask_id: subtask.id.clone(),
                status: "fail".into(),
                commands_run,
                errors,
                notes: vec!["test_command failed security validation".into()],
                intended_commands: subtask.test_commands.clone(),
            };
        }

        let output = Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .output()
            .await;

        match output {
            Ok(out) => {
                commands_run.push(cmd.clone());
                if !out.status.success() {
                    errors.push(format!(
                        "Command '{}' failed:\n{}",
                        cmd,
                        String::from_utf8_lossy(&out.stderr)
                    ));
                    // Log to audit — use as_str() to avoid double-ref
                    audit_log_command(cmd, false, errors.last().unwrap().as_str());
                    return ValidationResult {
                        subtask_id: subtask.id.clone(),
                        status: "fail".into(),
                        commands_run,
                        errors,
                        notes: vec![],
                        intended_commands: subtask.test_commands.clone(),
                    };
                }
                // Log success to audit
                audit_log_command(cmd, true, "");
            }
            Err(e) => {
                errors.push(format!("Failed to run '{}': {}", cmd, e));
                return ValidationResult {
                    subtask_id: subtask.id.clone(),
                    status: "fail".into(),
                    commands_run,
                    errors,
                    notes: vec![],
                    intended_commands: subtask.test_commands.clone(),
                };
            }
        }
    }

    ValidationResult {
        subtask_id: subtask.id.clone(),
        status: "pass".into(),
        commands_run,
        errors: vec![],
        notes: vec![],
        intended_commands: subtask.test_commands.clone(),
    }
}
```

---

## Planning model adapter

The planning model makes an internal function call to Aelvyril's gateway forwarding logic. PII is scrubbed automatically via the existing pipeline.

**Architecture choice: internal call, not HTTP loopback.** The orchestrator is inside the same Tauri process as the gateway. Rather than making an HTTP loopback call to `localhost:PORT/v1/chat/completions` (which adds serialize→HTTP→deserialize overhead for every planning call), the planner calls `gateway::forward::forward_chat_completion()` directly. This:
- Avoids ~5-10ms HTTP roundtrip per planning call
- Still runs PII detection/pseudonymization through the same code path
- Still records token usage and audit logs
- Still respects rate limits

The executor (pi) continues to make HTTP calls through the gateway, since it's a separate process.

```rust
/// Strip markdown code fences that LLMs commonly wrap JSON in.
/// Handles ```json ... ``` and ``` ... ``` patterns.
fn strip_code_fences(text: &str) -> &str {
    let trimmed = text.trim();
    if trimmed.starts_with("```") {
        // Find the closing fence
        let after_open = trimmed.trim_start_matches('`');
        // Skip language tag (e.g., "json\n")
        let content_start = match after_open.find('\n') {
            Some(pos) => after_open[pos + 1..].trim_start(),
            None => return trimmed,
        };
        // Strip trailing ```
        let content = content_start.strip_suffix("```").unwrap_or(content_start);
        return content.trim();
    }
    trimmed
}

async fn create_plan(
    task: &str,
    context: &PlanningContext,
    config: &OrchestratorSettings,
    app_state: &AppState,
) -> Result<Plan, PlanError> {
    let messages = build_planning_messages(task, context);

    // Direct internal call — no HTTP loopback
    let response = gateway::forward::forward_chat_completion(
        &app_state,
        &config.planning_model,
        messages,
    ).await?;

    // Strip code fences before parsing — LLMs frequently wrap JSON in ```json ... ```
    let cleaned = strip_code_fences(&response);

    // Parse strict JSON
    let plan: Plan = serde_json::from_str(cleaned)
        .map_err(|e| PlanError::InvalidJson(e.to_string()))?;

    // Detect dependency cycles — if A depends on B and B depends on A,
    // SELECT_SUBTASK will loop forever with no executable subtask.
    detect_dependency_cycles(&plan)?;

    Ok(plan)
}

/// Topological sort check — returns error if any cycle is found among subtasks.
fn detect_dependency_cycles(plan: &Plan) -> Result<(), PlanError> {
    use std::collections::{HashMap, HashSet};

    let mut graph: HashMap<&str, Vec<&str>> = HashMap::new();
    for st in &plan.subtasks {
        graph.insert(&st.id, st.depends_on.iter().map(|s| s.as_str()).collect());
    }

    fn has_cycle<'a>(
        node: &'a str,
        graph: &HashMap<&str, Vec<&str>>,
        visited: &mut HashSet<&'a str>,
        in_stack: &mut HashSet<&'a str>,
    ) -> bool {
        if in_stack.contains(node) { return true; }
        if visited.contains(node) { return false; }
        visited.insert(node);
        in_stack.insert(node);
        for dep in graph.get(node).into_iter().flatten() {
            if has_cycle(dep, graph, visited, in_stack) { return true; }
        }
        in_stack.remove(node);
        false
    }

    let mut visited = HashSet::new();
    let mut in_stack = HashSet::new();
    for st in &plan.subtasks {
        if has_cycle(&st.id, &graph, &mut visited, &mut in_stack) {
            return Err(PlanError::DependencyCycle(
                format!("Circular dependency detected involving subtask '{}'", st.id)
            ));
        }
    }
    Ok(())
}

async fn replan(
    plan: &Plan,
    subtask: &Subtask,
    validation: &ValidationResult,
    context: &PlanningContext,
    config: &OrchestratorSettings,
    app_state: &AppState,
) -> Result<ReplanResult, PlanError> {
    let messages = build_replan_messages(plan, subtask, validation, context);

    let response = gateway::forward::forward_chat_completion(
        &app_state,
        &config.planning_model,
        messages,
    ).await?;

    let cleaned = strip_code_fences(&response);
    serde_json::from_str(cleaned).map_err(|e| PlanError::InvalidJson(e.to_string()))
}
```

---

## Safeguards

- Executor changes files outside allowed_files → fail subtask, log to audit, replan
- Executor returns no meaningful output → retry with clarification (max 2x)
- Planner emits vague subtasks (no acceptance_criteria, no test_commands) → reject and re-plan with schema error
- Same failure occurs twice → escalate to REPLAN
- Pi process crashes → BLOCKED, show user crash log
- Pi exceeds max tool calls (default 30) → send abort, kill process, replan
- Pi exceeds timeout (default 10 min) → send abort, kill process, replan
- test_commands validated against whitelist before execution (no arbitrary shell commands)
- test_commands checked for shell metacharacters including `$`, backticks, newlines
- `allowed_files` scope check uses path-boundary matching (not naive prefix)
- Stderr drained in background task to prevent pipe deadlock
- Stdin owned explicitly so abort always reaches pi (unless pipe is broken)
- Command IDs include session nonce to prevent collision across restarts
- Dependency cycles detected at PARSE_PLAN time (topological sort)
- Planner response code fences stripped before JSON parsing
- All shell commands logged to Aelvyril audit log
- All LLM prompts pass through Aelvyril PII pipeline (automatic via internal call)

### Hard rules

- Max 1 active subtask at a time
- Max 2 executor retries before replan
- Max 6 files per subtask (configurable)
- Planning Model can widen scope; Executor Model cannot
- Pi is never reused across subtasks — new subprocess per subtask (clean state)
- test_commands must match the allowed command whitelist — no shell operators

---

## Config

Add to AppSettings:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OrchestratorSettings {
    pub enabled: bool,                       // default: false
    pub planning_model: String,              // e.g. "claude-sonnet-4" — routes via Aelvyril
    pub executor_model: String,              // e.g. "gpt-4o" — routes via Aelvyril
    pub max_subtask_retries: u8,             // default: 2
    pub max_files_per_subtask: usize,        // default: 6
    pub executor_timeout_secs: u64,          // default: 600 (10 min)
    pub max_tool_calls: u32,                 // default: 30
    pub allowed_test_commands: Vec<String>,  // default: empty (built-in whitelist is always active;
                                             //   this field extends it with project-specific commands)
}

impl Default for OrchestratorSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            planning_model: String::new(),   // must be configured before use
            executor_model: String::new(),   // must be configured before use
            max_subtask_retries: 2,
            max_files_per_subtask: 6,
            executor_timeout_secs: 600,
            max_tool_calls: 30,
            allowed_test_commands: Vec::new(),  // extends built-in whitelist; no extra commands by default
        }
    }
}
```

**Migration note:** `AppSettings` uses `#[serde(default)]`. When `OrchestratorSettings` is added as a field, existing config files will deserialize with `enabled: false` and empty model strings. The pre-flight check at INTAKE catches this gracefully — the user is prompted to configure models before first use. No config file migration needed.

Both planning_model and executor_model route through Aelvyril's existing provider system. The user configures them as model names — Aelvyril resolves them to upstream providers automatically via `config::find_provider_for_model()`.

---

## Module structure

```
src-tauri/src/orchestrator/
  mod.rs           -- Orchestrator struct, state machine loop, entry point
  types.rs         -- Task, Plan, Subtask, ExecutionResult, ValidationResult, OrchState
  contracts.rs     -- JSON schema validation for plan/exec/validate/replan
  planner.rs       -- Planning Model adapter (internal gateway call)
  executor.rs      -- pi RPC subprocess manager (spawn, monitor, abort/kill)
  context.rs       -- Context builder (planning=wide repo scan, executor=narrow subtask)
  validator.rs     -- runs whitelisted test_commands via user shell, logs to audit
  state_store.rs   -- SQLite via rusqlite (reuses existing dependency and connection pattern)
  errors.rs        -- OrchestratorError enum (integrates with existing error patterns)
```

**Note on contracts.rs:** Validates planner output against the Planning contract schema. Checks:
- `subtasks` is non-empty array
- Each subtask has `id`, `title`, `description`, `allowed_files`, `acceptance_criteria`
- `test_commands` entries pass `validate_test_command()` pre-check (catches planner hallucinating dangerous commands early)
- `depends_on` references only existing subtask IDs (no dangling refs)
- `allowed_files` entries are non-empty and don't contain `..` path traversal

Uses manual validation (not `jsonschema` crate) to keep dependencies minimal. On failure, returns `PlanError::SchemaViolation` with a specific message for the retry prompt.

**Note on SQLite:** The existing codebase already uses `rusqlite` for token usage persistence (`token_usage/store.rs`). Reuse the same crate and follow the same connection patterns. The orchestrator's SQLite database (`orchestrator.db`) can live alongside the existing token usage database.

**Note on errors:** `OrchestratorError` should implement `std::error::Error` and `Display` following Rust conventions. Where it wraps underlying errors (IO, JSON parse, gateway), use `thiserror` or manual `From` impls. Do NOT create a separate error ecosystem — integrate with how the rest of the codebase handles errors.

### Error variants

```rust
#[derive(Debug, thiserror::Error)]
pub enum OrchestratorError {
    #[error("No gateway key configured")]
    NoGatewayKey,

    #[error("Failed to spawn executor: {0}")]
    SpawnFailed(String),

    #[error("Executor exceeded tool call limit")]
    ToolCallLimit,

    #[error("Executor timed out")]
    ExecutorTimeout,

    #[error("Stdin write timed out (pipe may be broken)")]
    StdinTimeout,

    #[error("Executor touched {0} files, exceeding max {1}")]
    TooManyFiles(usize, usize),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Gateway error: {0}")]
    Gateway(String),
}

#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error("Invalid JSON from planning model: {0}")]
    InvalidJson(String),

    #[error("Dependency cycle detected: {0}")]
    DependencyCycle(String),

    #[error("Schema validation failed: {0}")]
    SchemaViolation(String),

    #[error("Gateway error: {0}")]
    Gateway(String),
}

#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("Command not in whitelist: {0}")]
    ForbiddenCommand(String),

    #[error("Shell metacharacters not allowed: {0}")]
    ShellOperatorsNotAllowed(String),
}
```

---

## New Tauri commands

```rust
// commands/orchestrator.rs

#[tauri::command]
async fn start_orchestrator_task(
    request: String,
    state: tauri::State<'_, Arc<RwLock<OrchestratorState>>>,
) -> Result<TaskId, String> {
    // Input validation
    if request.trim().is_empty() {
        return Err("Request cannot be empty".into());
    }
    if request.len() > 10_000 {
        return Err(format!("Request too long ({} chars, max 10000)", request.len()));
    }

    let task_id = generate_task_id();

    // Insert task synchronously BEFORE spawning the async loop.
    // This prevents the race where get_orchestrator_state is called
    // before the loop has written the initial state.
    {
        let mut orch = state.write().map_err(|e| e.to_string())?;
        orch.insert_pending_task(task_id.clone(), &request);
    }

    // Now spawn the state machine loop
    tokio::spawn(run_orchestrator(task_id.clone(), request, ...));

    Ok(task_id)
}

#[tauri::command]
async fn get_orchestrator_state(task_id: String) -> Result<OrchState, String>

#[tauri::command]
async fn continue_orchestrator(task_id: String) -> Result<OrchState, String>

#[tauri::command]
async fn cancel_orchestrator_task(task_id: String) -> Result<(), String>

#[tauri::command]
async fn get_orchestrator_plan(task_id: String) -> Result<Plan, String>

#[tauri::command]
async fn respond_to_blocked(task_id: String, user_input: String) -> Result<OrchState, String>

#[tauri::command]
async fn get_orchestrator_settings() -> Result<OrchestratorSettings, String>

#[tauri::command]
async fn update_orchestrator_settings(settings: OrchestratorSettings) -> Result<(), String>
```

Register in commands/mod.rs, add to invoke_handler:
```rust
// In commands/mod.rs invoke_handler():
    // ── Orchestrator ──
    start_orchestrator_task,
    get_orchestrator_state,
    continue_orchestrator,
    cancel_orchestrator_task,
    get_orchestrator_plan,
    respond_to_blocked,
    get_orchestrator_settings,
    update_orchestrator_settings,
```

---

## Minimal data model

```text
Task
  id                String
  user_request      String
  mode              "planned" | "direct"
  status            "intake" | "planning" | "executing" | "blocked" | "done"
  created_at        DateTime
  completed_at      Option<DateTime>

Plan
  task_id           String
  goal              String
  subtasks          Vec<Subtask>
  global_constraints Vec<String>
  completion_definition Vec<String>

Subtask
  id                String
  title             String
  description       String
  allowed_files     Vec<String>
  suggested_context_files Vec<String>
  constraints       Vec<String>
  test_commands     Vec<String>
  acceptance_criteria Vec<String>
  depends_on        Vec<String>
  retry_count       u8
  status            "pending" | "executing" | "completed" | "failed" | "blocked"

ExecutionResult
  subtask_id        String
  pi_completed      bool
  files_touched     Vec<String>
  files_outside_scope Vec<String>
  pi_summary        String
  tool_calls_made   u32
  turns_taken       u32         // v1: 0 (not tracked); v2: incremented on turn_end events
  needs_replan      bool
  replan_reason     Option<String>  // set when needs_replan is true

ValidationResult
  subtask_id        String
  status            "pass" | "fail"
  commands_run      Vec<String>
  intended_commands Vec<String>  // full test_commands list for replan context
  errors            Vec<String>
  notes             Vec<String>

OrchState
  task              Task
  plan              Option<Plan>
  current_subtask   Option<String>
  state             "intake" | "plan" | "parse_plan" | "select_subtask"
                   | "execute" | "parse_execution" | "validate"
                   | "complete_subtask" | "replan" | "done" | "blocked"
  retry_count       u8
  error_log         Vec<String>
```

---

## Pre-flight checks (at INTAKE)

Before entering the state machine:

```
1. Is gateway running? (check port listening)
   → No: BLOCKED "Start Aelvyril gateway first"

2. Are providers configured?
   → No: BLOCKED "Add an upstream provider"

3. Is planning_model set in settings? (non-empty string)
   → No: BLOCKED "Configure planning_model in orchestrator settings"

4. Is executor_model set in settings? (non-empty string)
   → No: BLOCKED "Configure executor_model in orchestrator settings"

5. Can planning_model be resolved to a provider? (via find_provider_for_model)
   → No: BLOCKED "No provider configured for model '{planning_model}'"

6. Can executor_model be resolved to a provider?
   → No: BLOCKED "No provider configured for model '{executor_model}'"

7. Is pi installed? (sh -c "which pi")
   → No: BLOCKED "Install pi: npm install -g @mariozechner/pi-coding-agent"

8. Does ~/.pi/agent/models.json have an "aelvyril" provider pointing at the gateway?
   (Read models.json, check for provider with name "aelvyril" and baseUrl matching localhost:gateway_port)
   → No: **Auto-fix** — write/update the "aelvyril" provider entry in models.json:
     ```json
     {
       "providers": {
         "aelvyril": {
           "baseUrl": "http://localhost:{gateway_port}/v1",
           "api": "openai-completions",
           "apiKey": "{gateway_key}",
           "models": [
             { "id": "{executor_model}" },
             { "id": "{planning_model}" }
           ]
         }
       }
     }
     ```
     This is merged with any existing providers in models.json (not overwritten).
     After writing, re-read to verify. If write fails → BLOCKED "Cannot write pi config."

All pass → continue
```

**Why models.json, not CLI flags:** Pi has `--provider`, `--model`, and `--api-key` CLI flags, but **no `--api-base` flag**. There is no way to set the provider's base URL from the command line. Providers are configured either via extensions (`pi.registerProvider()`) or `~/.pi/agent/models.json`. Since the orchestrator can't load an extension at spawn time, models.json is the integration point.

**Pre-flight auto-writes the entry.** The first time the orchestrator runs, it checks models.json for an "aelvyril" provider. If missing or stale (wrong port/key), it writes the correct entry. This is a one-time setup that persists across sessions. The user never has to manually edit models.json.

**This also covers integration #1 (manual pi usage).** Once models.json has the "aelvyril" provider, a user can run `pi --provider aelvyril --model gpt-4o` directly in the terminal and it routes through Aelvyril's gateway with PII protection. Same config serves both use cases.

---

## Pseudocode

```
function handle_request(user_request):
    // Classify
    if is_simple_question(user_request):
        return route_to_normal_gateway(user_request)

    // Pre-flight
    check = preflight()
    if check.failed:
        return show_blocked(check.reason)

    // Plan or direct
    repo_context = build_repo_tree_summary(repo_path)  // lightweight Rust fn, no pi spawn
    task = create_task(user_request)

    if needs_planning(user_request):
        plan = planning_model.create_plan(user_request, repo_context)
        if plan.invalid:
            if retry < 2: retry with schema error
            else: return blocked("Planning failed")
        plan = parse_and_validate(plan)
    else:
        plan = make_single_step_plan(user_request, repo_context)

    state.plan = plan

    // Execute loop
    while not all_subtasks_complete(plan):
        subtask = select_next_subtask(plan)

        exec_context = build_executor_context(subtask, state)
        result = spawn_pi_executor(subtask, exec_context, app_state)  // passes gateway key + port

        if result.timed_out or result.crashed:
            return blocked("Executor crashed/timed out", result.log)

        if result.touched_outside_scope:
            validation = fail("executor changed forbidden files: " + result.files_outside_scope)
        else:
            validation = run_validation(subtask.test_commands)  // whitelist enforced

        if validation.status == "pass":
            mark_complete(subtask, result, validation)
            continue

        // Retry
        if subtask.retry_count < 2:
            subtask.retry_count += 1
            exec_context.errors = validation.errors
            result = spawn_pi_executor(subtask, exec_context)
            validation = run_validation(subtask.test_commands)

            if validation.status == "pass":
                mark_complete(subtask, result, validation)
                continue

        // Replan
        replan = planning_model.replan(plan, subtask, validation, repo_context)
        if replan.failed:
            return blocked("Replan failed, need manual input")

        update_plan(plan, replan)

    return final_summary(plan, state)
```

---

## Known limitations (v1)

| Limitation | Impact | Mitigation |
|---|---|---|
| `files_touched` misses bash-modified files | Scope check may not catch `sed`/`mv` changes | Validator catches regressions; optional `git diff` audit post-execution |
| Gateway key visible in `ps` output | Other users on the machine can see the `--api-key` argument | Fixed: pass via `PI_API_KEY` env var instead of CLI arg. If pi doesn't support env var, fall back to CLI arg (documented in code) |
| New pi subprocess per subtask (cold start) | ~300-500ms overhead per subtask | Accepted for v1; warm process pool if it becomes bottleneck |
| test_commands whitelist is built-in only | Rare commands may be blocked | `allowed_test_commands` in settings extends the whitelist per project |
| No streaming progress to UI | User sees nothing until subtask completes | v1 polls state; v2 forwards `message_update` events via Tauri events |
| No concurrent subtasks | Serial execution only | By design — parallel subtasks risk conflicting file changes |
| `allowed_files` matching is path-boundary-based | `src/` matches `src/foo` but not `src_backup/foo` | Fixed with `is_path_within()` helper |

---

## v1 scope

- Triggered from Aelvyril dashboard (Tauri command)
- One repo at a time, one plan at a time, one active subtask
- Planning Model = internal LLM call through Aelvyril gateway (no HTTP loopback)
- Executor = pi via RPC (new subprocess per subtask)
- Validator = whitelisted shell commands with audit logging
- State in SQLite (separate from app state to avoid lock contention)
- BLOCKED state shows in Aelvyril UI for user input
- No streaming in v1 (blocking calls, UI polls `get_orchestrator_state`)
- Pi tool output passes through Aelvyril's PII pipeline (automatic via gateway)

## v2 considerations (not in scope)

- Stream `message_update` and `tool_execution_*` events to the frontend via Tauri events for live progress
- Settings UI for `allowed_test_commands` (currently config-file only)
- Warm pi process pool to reduce cold start latency
- `git diff` based full-file-change audit post-execution (catches bash modifications)
- Parallel subtasks for independent changes (requires conflict detection)
- Glob-based `allowed_files` patterns

## Implementation priority order

1. **`types.rs` + `contracts.rs` + `errors.rs`** — Foundation types and validation
2. **`state_store.rs`** — SQLite persistence layer
3. **`executor.rs`** — pi RPC proof-of-concept (spawn pi, send prompt, parse events) — **validate the Rust↔TypeScript RPC bridge first before building the rest**
4. **`planner.rs`** — Planning model adapter via internal gateway call
5. **`context.rs`** — Context builder (lightweight repo scan + subtask narrowing)
6. **`validator.rs`** — Whitelisted test command runner
7. **`mod.rs`** — State machine loop (ties everything together)
8. **Tauri commands + UI integration** — Wire up to frontend
