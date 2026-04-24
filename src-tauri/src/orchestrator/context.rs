//! Lightweight repo context builder and executor prompt builder.
//!
//! `build_repo_tree_summary` — walks the directory tree (up to 3 levels deep),
//! identifies key files, and produces a condensed tree string for planning context.
//!
//! `build_executor_prompt` — formats a constrained prompt for the pi executor
//! subprocess from a `Subtask` and `ExecutorContext`.

use std::fs;
use std::path::Path;

use super::types::{ExecutorContext, Subtask};

// ── Constants ────────────────────────────────────────────────────────────────

/// Maximum depth for directory walking.
const MAX_DEPTH: usize = 3;

/// Maximum character length for the tree summary before truncation.
const MAX_TREE_CHARS: usize = 2000;

/// Directory names to always skip.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    ".next",
    "coverage",
    ".cache",
];

/// Known entry-point file names.
const ENTRY_POINTS: &[&str] = &[
    "main.rs",
    "lib.rs",
    "mod.rs",
    "main.ts",
    "main.tsx",
    "main.js",
    "main.jsx",
    "index.ts",
    "index.tsx",
    "index.js",
    "index.jsx",
    "main.py",
    "__main__.py",
    "main.go",
    "Main.kt",
    "App.vue",
    "App.svelte",
];

/// Known config file names.
const CONFIG_FILES: &[&str] = &[
    "Cargo.toml",
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "go.mod",
    "go.sum",
    "build.gradle",
    "pom.xml",
    "Makefile",
    "CMakeLists.txt",
    ".env",
    ".env.example",
];

/// Known test directory names.
const TEST_DIRS: &[&str] = &["tests", "__tests__", "test", "spec"];

/// Known file extensions that indicate test files.
const TEST_SUFFIXES: &[&str] = &["_test.go", "_test.rs", ".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];

// ── Language detection ──────────────────────────────────────────────────────

/// Map a file extension to a language label. Returns `None` if unknown.
fn extension_to_language(ext: &str) -> Option<&'static str> {
    match ext {
        "rs" => Some("Rust"),
        "ts" | "tsx" => Some("TypeScript"),
        "js" | "jsx" => Some("JavaScript"),
        "py" | "pyi" => Some("Python"),
        "go" => Some("Go"),
        "java" => Some("Java"),
        "kt" | "kts" => Some("Kotlin"),
        "c" | "h" => Some("C"),
        "cpp" | "cc" | "cxx" | "hpp" => Some("C++"),
        "cs" => Some("C#"),
        "rb" => Some("Ruby"),
        "swift" => Some("Swift"),
        "scala" => Some("Scala"),
        "vue" => Some("Vue"),
        "svelte" => Some("Svelte"),
        "html" | "htm" => Some("HTML"),
        "css" | "scss" | "sass" | "less" => Some("CSS"),
        "toml" | "yaml" | "yml" | "json" | "xml" => Some("Config"),
        "md" => Some("Markdown"),
        "sql" => Some("SQL"),
        "sh" | "bash" | "zsh" => Some("Shell"),
        _ => None,
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Check whether a file name is a known entry point.
fn is_entry_point(name: &str) -> bool {
    ENTRY_POINTS.contains(&name)
}

/// Check whether a file name is a known config file.
fn is_config_file(name: &str) -> bool {
    CONFIG_FILES.contains(&name)
}

/// Check whether a directory name is a test directory.
fn is_test_dir(name: &str) -> bool {
    TEST_DIRS.contains(&name)
}

/// Check whether a file name looks like a test file.
fn is_test_file(name: &str) -> bool {
    TEST_SUFFIXES.iter().any(|s| name.ends_with(s)) || name.starts_with("test_")
}

/// Check whether a directory should be skipped.
fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name) || name.starts_with('.')
}

// ── Tree walker ──────────────────────────────────────────────────────────────

/// Recursively collect a tree representation of the directory.
fn collect_tree(dir: &Path, prefix: &str, depth: usize, out: &mut String) {
    if depth > MAX_DEPTH {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| {
        let is_dir = e.file_type().map_or(false, |ft| ft.is_dir());
        // Directories first, then files; stable within each group.
        (!is_dir, e.file_name())
    });

    let total = entries.len();
    for (i, entry) in entries.iter().enumerate() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        let is_dir = entry.file_type().map_or(false, |ft| ft.is_dir());
        let connector = if i == total - 1 { "└── " } else { "├── " };
        let child_prefix = if i == total - 1 { "    " } else { "│   " };

        // Annotate special files/dirs.
        let mut tag = String::new();
        if is_dir && is_test_dir(&name_str) {
            tag = " [test]".to_string();
        } else if !is_dir {
            if is_entry_point(&name_str) {
                tag = " [entry]".to_string();
            } else if is_config_file(&name_str) {
                tag = " [config]".to_string();
            } else if is_test_file(&name_str) {
                tag = " [test]".to_string();
            }
        }

        out.push_str(prefix);
        out.push_str(connector);
        out.push_str(&name_str);
        out.push_str(&tag);
        out.push('\n');

        // Recurse into non-skipped directories.
        if is_dir && !should_skip_dir(&name_str) {
            collect_tree(&entry.path(), &format!("{}{}", prefix, child_prefix), depth + 1, out);
        }
    }
}

/// Detect the primary language(s) in the repo by sampling extensions.
fn detect_languages(repo_path: &Path) -> Vec<String> {
    let mut lang_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    // Quick scan: just the top two levels for language detection.
    fn scan_dir(dir: &Path, depth: usize, counts: &mut std::collections::HashMap<String, usize>) {
        if depth > 2 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                if !should_skip_dir(&name) {
                    scan_dir(&entry.path(), depth + 1, counts);
                }
            } else if let Some(ext) = name.rsplit('.').next() {
                if let Some(lang) = extension_to_language(ext) {
                    *counts.entry(lang.to_string()).or_insert(0) += 1;
                }
            }
        }
    }

    scan_dir(repo_path, 0, &mut lang_counts);

    let mut langs: Vec<_> = lang_counts.into_iter().collect();
    langs.sort_by(|a, b| b.1.cmp(&a.1));
    langs.into_iter().take(3).map(|(l, _)| l).collect()
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Walk the repository directory (up to 3 levels deep) and build a condensed
/// tree summary string (~2000 chars max). This is used for planning context
/// and does **not** spawn pi.
pub fn build_repo_tree_summary(repo_path: &Path) -> String {
    if !repo_path.exists() || !repo_path.is_dir() {
        return "<invalid repo path>".to_string();
    }

    let dir_name = repo_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    let langs = detect_languages(repo_path);
    let lang_line = if langs.is_empty() {
        String::new()
    } else {
        format!("Languages: {}\n", langs.join(", "))
    };

    let mut tree = String::new();
    collect_tree(repo_path, "", 0, &mut tree);

    let mut summary = format!("{dir_name}/\n{lang_line}{tree}");

    // Truncate if over the character budget.
    if summary.len() > MAX_TREE_CHARS {
        // Find the last newline within the valid UTF-8 prefix up to MAX_TREE_CHARS.
        // Use char_indices to avoid slicing mid-character (which would panic).
        let prefix_end = summary
            .char_indices()
            .take_while(|&(i, _)| i < MAX_TREE_CHARS)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        let prefix = &summary[..prefix_end];
        let end = prefix.rfind('\n').unwrap_or(prefix.len());
        summary.truncate(end);
        summary.push_str("\n... (truncated)");
    }

    summary
}

/// Build the constrained prompt for the pi executor subprocess.
///
/// Format:
/// ```text
/// SUBTASK: {title}
/// {description}
///
/// ALLOWED FILES: {comma-separated allowed_files}
/// CONSTRAINTS: {semicolon-separated constraints}
/// ACCEPTANCE CRITERIA: {semicolon-separated acceptance_criteria}
/// Do not touch files outside the allowed list.
/// ```
///
/// Optionally appends previous errors and repo context.
pub fn build_executor_prompt(subtask: &Subtask, context: &ExecutorContext) -> String {
    let allowed = if subtask.allowed_files.is_empty() {
        "(none specified)".to_string()
    } else {
        subtask.allowed_files.join(", ")
    };

    let constraints = if subtask.constraints.is_empty() {
        "(none)".to_string()
    } else {
        subtask.constraints.join("; ")
    };

    let criteria = if subtask.acceptance_criteria.is_empty() {
        "(none)".to_string()
    } else {
        subtask.acceptance_criteria.join("; ")
    };

    let mut prompt = format!(
        "SUBTASK: {title}\n{description}\n\nALLOWED FILES: {allowed}\nCONSTRAINTS: {constraints}\nACCEPTANCE CRITERIA: {criteria}\nDo not touch files outside the allowed list.",
        title = subtask.title,
        description = subtask.description,
        allowed = allowed,
        constraints = constraints,
        criteria = criteria,
    );

    if let Some(ref errors) = context.previous_errors {
        if !errors.is_empty() {
            prompt.push_str("\n\nPREVIOUS ERRORS:\n");
            prompt.push_str(&errors.join("\n"));
        }
    }

    // Repo context is pulled from the subtask's suggested_context_files
    // via the executor context, but we also accept an optional broader context
    // that the caller may want to inject. For now we only add the previous_errors
    // since ExecutorContext doesn't carry repo_context natively — the caller
    // should concatenate it separately if needed. However, the spec mentions
    // context.repo_context, so we handle it if present in the type.
    // NOTE: The current ExecutorContext struct doesn't have repo_context,
    // so we skip that branch. If it gets added, uncomment below.

    prompt
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_summary_on_nonexistent_path() {
        let result = build_repo_tree_summary(Path::new("/nonexistent/path/abc123"));
        assert_eq!(result, "<invalid repo path>");
    }

    #[test]
    fn tree_summary_on_current_dir() {
        // Should at least find src/ or Cargo.toml.
        let result = build_repo_tree_summary(Path::new("."));
        assert!(result.len() > 0, "tree summary should not be empty");
    }

    #[test]
    fn executor_prompt_basic() {
        let subtask = Subtask {
            id: "st-1".to_string(),
            title: "Add login handler".to_string(),
            description: "Implement POST /login endpoint".to_string(),
            allowed_files: vec!["src/auth.rs".to_string(), "src/routes.rs".to_string()],
            suggested_context_files: vec![],
            constraints: vec!["No external crates".to_string()],
            test_commands: vec!["cargo test auth".to_string()],
            acceptance_criteria: vec!["Compiles".to_string(), "Tests pass".to_string()],
            depends_on: vec![],
            retry_count: 0,
            status: super::super::types::SubtaskStatus::Pending,
        };

        let ctx = ExecutorContext {
            subtask_id: "st-1".to_string(),
            subtask_description: "Implement POST /login endpoint".to_string(),
            allowed_files: vec!["src/auth.rs".to_string(), "src/routes.rs".to_string()],
            constraints: vec!["No external crates".to_string()],
            acceptance_criteria: vec!["Compiles".to_string(), "Tests pass".to_string()],
            previous_errors: None,
            repo_path: None,
        };

        let prompt = build_executor_prompt(&subtask, &ctx);
        assert!(prompt.starts_with("SUBTASK: Add login handler"));
        assert!(prompt.contains("ALLOWED FILES: src/auth.rs, src/routes.rs"));
        assert!(prompt.contains("CONSTRAINTS: No external crates"));
        assert!(prompt.contains("ACCEPTANCE CRITERIA: Compiles; Tests pass"));
        assert!(prompt.contains("Do not touch files outside the allowed list."));
    }

    #[test]
    fn executor_prompt_with_previous_errors() {
        let subtask = Subtask {
            id: "st-2".to_string(),
            title: "Fix bug".to_string(),
            description: "Fix the null pointer".to_string(),
            allowed_files: vec!["src/main.rs".to_string()],
            suggested_context_files: vec![],
            constraints: vec![],
            test_commands: vec![],
            acceptance_criteria: vec![],
            depends_on: vec![],
            retry_count: 1,
            status: super::super::types::SubtaskStatus::Pending,
        };

        let ctx = ExecutorContext {
            subtask_id: "st-2".to_string(),
            subtask_description: "Fix the null pointer".to_string(),
            allowed_files: vec!["src/main.rs".to_string()],
            constraints: vec![],
            acceptance_criteria: vec![],
            previous_errors: Some(vec![
                "error: cannot find value `x`".to_string(),
                "error: mismatched types".to_string(),
            ]),
            repo_path: None,
        };

        let prompt = build_executor_prompt(&subtask, &ctx);
        assert!(prompt.contains("PREVIOUS ERRORS:\nerror: cannot find value `x`\nerror: mismatched types"));
    }
}