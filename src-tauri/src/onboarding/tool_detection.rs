pub fn detect_cursor() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new("/Applications/Cursor.app").exists()
            || std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
                .join(".cursor")
                .exists()
    }
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/usr/bin/cursor").exists()
            || std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
                .join(".cursor")
                .exists()
    }
    #[cfg(target_os = "windows")]
    {
        std::path::Path::new(r"C:\\Program Files\\Cursor").exists()
            || std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
                .join(".cursor")
                .exists()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

pub fn detect_vscode() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new("/Applications/Visual Studio Code.app").exists()
    }
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/usr/bin/code").exists()
    }
    #[cfg(target_os = "windows")]
    {
        std::path::Path::new(r"C:\\Program Files\\Microsoft VS Code").exists()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

pub fn detect_claude_cli() -> bool {
    std::process::Command::new("which")
        .arg("claude")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

