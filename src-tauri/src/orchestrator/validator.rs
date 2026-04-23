//! Validator — runs whitelisted test commands after pi execution.
//!
//! All test commands are validated against a whitelist before execution.
//! Results are logged to the audit store.

use std::process::Stdio;
use tokio::process::Command;

use super::errors::OrchestratorError;
use super::types::{Subtask, ValidationResult, ValidationStatus};

/// Built-in allowed test command prefixes.
///
/// Users can extend this via `allowed_test_commands` in OrchestratorSettings.
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

/// Validate a test command against the whitelist.
///
/// Returns Ok(()) if the command is allowed, Err with a descriptive message
/// if it's not.
pub fn validate_test_command(
    cmd: &str,
    extra_allowed: &[String],
) -> Result<(), OrchestratorError> {
    let trimmed = cmd.trim();

    if trimmed.is_empty() {
        return Err(OrchestratorError::ForbiddenTestCommand(
            "Empty test command".into(),
        ));
    }

    // Check against built-in whitelist
    let allowed = BUILTIN_ALLOWED_TEST_COMMANDS
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
        || extra_allowed.iter().any(|prefix| trimmed.starts_with(prefix.as_str()));

    if !allowed {
        return Err(OrchestratorError::ForbiddenTestCommand(
            trimmed.to_string(),
        ));
    }

    // Reject shell operators that could chain arbitrary commands
    if trimmed.contains("&&")
        || trimmed.contains("||")
        || trimmed.contains('|')
        || trimmed.contains('>')
        || trimmed.contains(">>")
        || trimmed.contains(';')
        || trimmed.contains('`')
        || trimmed.contains("$(")
        // Reject newline/carriage return — sh -c executes each line independently,
        // so "cargo test\nrm -rf /" passes the prefix check but runs both commands.
        || trimmed.contains('\n')
        || trimmed.contains('\r')
    {
        return Err(OrchestratorError::ShellOperatorsNotAllowed(
            trimmed.to_string(),
        ));
    }

    Ok(())
}

/// Run all test commands for a subtask.
///
/// Each command is validated against the whitelist before execution.
/// Stops on the first failure and returns the result.
pub async fn run_validation(
    subtask: &Subtask,
    extra_allowed: &[String],
    working_dir: Option<&std::path::Path>,
) -> ValidationResult {
    let mut commands_run = Vec::new();
    let mut errors = Vec::new();

    if subtask.test_commands.is_empty() {
        // No test commands — skip validation (pass by default)
        tracing::info!(
            "No test commands for subtask {}, skipping validation",
            subtask.id
        );
        return ValidationResult {
            subtask_id: subtask.id.clone(),
            status: ValidationStatus::Pass,
            commands_run: vec![],
            errors: vec![],
            notes: vec!["No test commands specified, validation skipped".into()],
        };
    }

    for cmd in &subtask.test_commands {
        // Security: validate against whitelist
        if let Err(e) = validate_test_command(cmd, extra_allowed) {
            errors.push(format!("Command '{}' rejected: {}", cmd, e));
            return ValidationResult {
                subtask_id: subtask.id.clone(),
                status: ValidationStatus::Fail,
                commands_run,
                errors,
                notes: vec!["Test command failed security validation".into()],
            };
        }

        // Execute the command
        let mut tokio_cmd = Command::new("sh");
        tokio_cmd.arg("-c").arg(cmd);
        tokio_cmd.stdin(Stdio::null());
        tokio_cmd.stdout(Stdio::piped());
        tokio_cmd.stderr(Stdio::piped());

        if let Some(dir) = working_dir {
            tokio_cmd.current_dir(dir);
        }

        let output = tokio_cmd.output().await;

        match output {
            Ok(out) => {
                commands_run.push(cmd.clone());
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let mut error_msg = format!("Command '{}' failed (exit code {:?})", cmd, out.status.code());
                    if !stderr.is_empty() {
                        error_msg.push_str(&format!("\nSTDERR:\n{}", stderr));
                    }
                    if !stdout.is_empty() {
                        error_msg.push_str(&format!("\nSTDOUT:\n{}", stdout));
                    }
                    errors.push(error_msg);

                    tracing::warn!("Validation command failed: {}", cmd);
                    return ValidationResult {
                        subtask_id: subtask.id.clone(),
                        status: ValidationStatus::Fail,
                        commands_run,
                        errors,
                        notes: vec![],
                    };
                }
                tracing::debug!("Validation command passed: {}", cmd);
            }
            Err(e) => {
                errors.push(format!("Failed to execute '{}': {}", cmd, e));
                return ValidationResult {
                    subtask_id: subtask.id.clone(),
                    status: ValidationStatus::Fail,
                    commands_run,
                    errors,
                    notes: vec![],
                };
            }
        }
    }

    ValidationResult {
        subtask_id: subtask.id.clone(),
        status: ValidationStatus::Pass,
        commands_run,
        errors: vec![],
        notes: vec![],
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_allowed_commands() {
        assert!(validate_test_command("cargo test", &[]).is_ok());
        assert!(validate_test_command("npm test", &[]).is_ok());
        assert!(validate_test_command("cargo check", &[]).is_ok());
        assert!(validate_test_command("pytest", &[]).is_ok());
        assert!(validate_test_command("npx tsc --noEmit", &[]).is_ok());
    }

    #[test]
    fn test_validate_rejects_unknown() {
        assert!(validate_test_command("rm -rf /", &[]).is_err());
        assert!(validate_test_command("curl evil.com", &[]).is_err());
    }

    #[test]
    fn test_validate_rejects_shell_operators() {
        assert!(validate_test_command("cargo test && echo done", &[]).is_err());
        assert!(validate_test_command("npm test | tee log", &[]).is_err());
        assert!(validate_test_command("cargo test; rm -rf /", &[]).is_err());
    }

    #[test]
    fn test_validate_extra_allowed() {
        let extra = vec!["my-custom-test".to_string()];
        assert!(validate_test_command("my-custom-test --verbose", &extra).is_ok());
        assert!(validate_test_command("other-command", &extra).is_err());
    }

    #[test]
    fn test_validate_empty_command() {
        assert!(validate_test_command("", &[]).is_err());
        assert!(validate_test_command("  ", &[]).is_err());
    }
}
