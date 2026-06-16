use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SecurityError {
    #[error("window is not allowed to invoke this command")]
    WindowDenied,
    #[error("invalid path")]
    InvalidPath,
    #[error("path escapes allowed root")]
    PathTraversal,
    #[error("file is too large")]
    FileTooLarge,
    #[error("unsupported URL scheme")]
    UnsupportedUrl,
    #[error("clipboard access is disabled")]
    ClipboardDisabled,
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for SecurityError {
    fn from(value: std::io::Error) -> Self {
        SecurityError::Io(value.to_string())
    }
}

impl Serialize for SecurityError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AllowedBase {
    AppData,
    AppConfig,
    AppCache,
    Assets,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedPath {
    pub base: AllowedBase,
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedFile {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub size: u64,
}

pub fn require_main_window(label: &str) -> Result<(), SecurityError> {
    if label == "main" {
        Ok(())
    } else {
        Err(SecurityError::WindowDenied)
    }
}

pub fn resolve_scoped_path<R: Runtime>(app: &AppHandle<R>, request: &ScopedPath) -> Result<PathBuf, SecurityError> {
    let root = allowed_root(app, &request.base)?;
    let relative = clean_relative_path(&request.relative_path)?;
    let candidate = root.join(relative);
    ensure_under_root(&root, &candidate)?;
    Ok(candidate)
}

pub fn read_scoped_file<R: Runtime>(app: &AppHandle<R>, request: &ScopedPath, max_bytes: u64) -> Result<String, SecurityError> {
    let path = resolve_scoped_path(app, request)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > max_bytes {
        return Err(SecurityError::FileTooLarge);
    }
    Ok(fs::read_to_string(path)?)
}

pub fn write_scoped_file<R: Runtime>(app: &AppHandle<R>, request: &ScopedPath, contents: &str, max_bytes: u64) -> Result<(), SecurityError> {
    if contents.as_bytes().len() as u64 > max_bytes {
        return Err(SecurityError::FileTooLarge);
    }
    let path = resolve_scoped_path(app, request)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}

pub fn list_scoped_files<R: Runtime>(app: &AppHandle<R>, request: &ScopedPath) -> Result<Vec<ListedFile>, SecurityError> {
    let dir = resolve_scoped_path(app, request)?;
    let mut files = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        files.push(ListedFile {
            name: file_name.clone(),
            relative_path: join_relative(&request.relative_path, &file_name),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

pub fn validate_external_url(url: &str) -> Result<url::Url, SecurityError> {
    let parsed = url::Url::parse(url).map_err(|_| SecurityError::UnsupportedUrl)?;
    match parsed.scheme() {
        "https" | "http" | "mailto" => Ok(parsed),
        _ => Err(SecurityError::UnsupportedUrl),
    }
}

fn allowed_root<R: Runtime>(app: &AppHandle<R>, base: &AllowedBase) -> Result<PathBuf, SecurityError> {
    let path = match base {
        AllowedBase::AppData => app.path().app_local_data_dir().map_err(|error| SecurityError::Io(error.to_string()))?,
        AllowedBase::AppConfig => app.path().app_config_dir().map_err(|error| SecurityError::Io(error.to_string()))?,
        AllowedBase::AppCache => app.path().app_cache_dir().map_err(|error| SecurityError::Io(error.to_string()))?,
        AllowedBase::Assets => app.path().resolve("assets", tauri::path::BaseDirectory::Resource)
            .map_err(|error| SecurityError::Io(error.to_string()))?,
    };
    Ok(path)
}

fn clean_relative_path(input: &str) -> Result<PathBuf, SecurityError> {
    if input.trim().is_empty() {
        return Ok(PathBuf::new());
    }
    let path = Path::new(input);
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => output.push(segment),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(SecurityError::PathTraversal);
            }
        }
    }
    Ok(output)
}

fn ensure_under_root(root: &Path, candidate: &Path) -> Result<(), SecurityError> {
    let canonical_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let existing = if candidate.exists() {
        fs::canonicalize(candidate)?
    } else {
        let parent = candidate.parent().ok_or(SecurityError::InvalidPath)?;
        let canonical_parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        canonical_parent.join(candidate.file_name().ok_or(SecurityError::InvalidPath)?)
    };
    if existing.starts_with(canonical_root) {
        Ok(())
    } else {
        Err(SecurityError::PathTraversal)
    }
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.trim().is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_traversal() {
        let err = clean_relative_path("../secret.txt").unwrap_err();
        assert!(matches!(err, SecurityError::PathTraversal));
    }

    #[test]
    fn rejects_absolute_path() {
        let err = clean_relative_path("/etc/passwd").unwrap_err();
        assert!(matches!(err, SecurityError::PathTraversal));
    }

    #[test]
    fn validates_only_safe_url_schemes() {
        assert!(validate_external_url("https://example.com").is_ok());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
    }
}
