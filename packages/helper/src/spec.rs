//! The spec the pi extension hands to the helper.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// What the command is allowed to touch.
///
/// The extension writes this as JSON at activation time, so every bash call in
/// the session reuses one file instead of a fresh document per command.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    /// Directory the command runs in.
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    /// Paths the command may read and execute through. Empty means nothing is
    /// readable, which is rarely what a caller wants; the extension always
    /// sends at least `/`.
    #[serde(default)]
    pub read: Vec<PathBuf>,
    /// Paths the command may create, change and delete. Everything outside is
    /// read-only, which is the whole point of the sandbox.
    #[serde(default)]
    pub write: Vec<PathBuf>,
    /// Run the command without network access. Named for what the helper does,
    /// so the sandbox only ever has to act on a positive condition.
    #[serde(default)]
    pub offline: bool,
    /// Environment variables to set for the command.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl Spec {
    /// Parse a spec document and reject paths that cannot be sandboxed.
    pub fn parse(text: &str) -> Result<Self, String> {
        let spec: Spec =
            serde_json::from_str(text).map_err(|e| format!("spec is not valid JSON: {e}"))?;
        for path in spec.read.iter().chain(spec.write.iter()) {
            if path.is_absolute() {
                if path.as_os_str().to_string_lossy().contains('\0') {
                    return Err(format!("spec path {path:?} contains a NUL byte"));
                }
            } else {
                return Err(format!(
                    "spec path {path:?} is relative; every path must be absolute"
                ));
            }
        }
        if let Some(cwd) = &spec.cwd {
            if !cwd.is_absolute() {
                return Err(format!("spec cwd {cwd:?} is relative; it must be absolute"));
            }
        }
        Ok(spec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_spec() {
        let spec = Spec::parse(
            r#"{"cwd":"/work","read":["/"],"write":["/work/src"],"offline":true,"env":{"A":"b"}}"#,
        )
        .expect("spec should parse");
        assert_eq!(spec.read, vec![PathBuf::from("/")]);
        assert_eq!(spec.write, vec![PathBuf::from("/work/src")]);
        assert!(spec.offline);
        assert_eq!(spec.env.get("A").map(String::as_str), Some("b"));
    }

    #[test]
    fn defaults_are_empty_and_online() {
        let spec = Spec::parse("{}").expect("an empty spec is valid");
        assert!(spec.read.is_empty());
        assert!(spec.write.is_empty());
        assert!(spec.offline == false);
        assert!(spec.cwd.is_none());
    }

    #[test]
    fn rejects_relative_paths() {
        let error =
            Spec::parse(r#"{"write":["src/auth"]}"#).expect_err("relative paths are refused");
        assert!(
            error.contains("must be absolute"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn rejects_unknown_keys() {
        let error = Spec::parse(r#"{"writable":"/work"}"#).expect_err("unknown keys are refused");
        assert!(
            error.contains("not valid JSON"),
            "unexpected error: {error}"
        );
    }
}
