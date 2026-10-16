use std::path::{Path, PathBuf};

/// Canonicalize without the `\\?\` verbatim prefix Windows adds, so paths stay
/// readable in the UI and work with `explorer.exe /select`.
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Case-insensitive, separator-agnostic key used to compare Windows paths.
pub fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/// True when one path equals, contains or is contained by the other.
pub fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = path_key(left);
    let right = path_key(right);
    left == right
        || left.starts_with(&format!("{right}\\"))
        || right.starts_with(&format!("{left}\\"))
}

/// Escape `%`, `_` and the escape character itself for a SQL `LIKE ... ESCAPE '!'`.
pub fn like_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    for ch in value.chars() {
        if matches!(ch, '%' | '_' | '!') {
            out.push('!');
        }
        out.push(ch);
    }
    out
}

/// Parent folder of a path string, using either separator.
pub fn parent_of(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['\\', '/']);
    let index = trimmed.rfind(['\\', '/'])?;
    if index == 0 {
        return None;
    }
    let parent = &trimmed[..index];
    // "D:" is a drive, not a folder we can browse.
    if parent.ends_with(':') {
        return Some(format!("{parent}\\"));
    }
    Some(parent.to_owned())
}

pub fn file_name_of(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(trimmed)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_detects_nested_and_equal_paths() {
        assert!(paths_overlap(
            Path::new(r"D:\Photos"),
            Path::new(r"D:\Photos\2026")
        ));
        assert!(paths_overlap(
            Path::new(r"D:\Photos\2026"),
            Path::new(r"d:\photos")
        ));
        assert!(paths_overlap(
            Path::new(r"D:\Photos"),
            Path::new(r"D:\Photos\")
        ));
        assert!(!paths_overlap(
            Path::new(r"D:\Photos"),
            Path::new(r"D:\PhotosOld")
        ));
        assert!(!paths_overlap(
            Path::new(r"D:\Photos"),
            Path::new(r"D:\Work")
        ));
    }

    #[test]
    fn like_escape_protects_wildcards() {
        assert_eq!(like_escape("50%_off!"), "50!%!_off!!");
    }

    #[test]
    fn parent_and_name_helpers() {
        assert_eq!(parent_of(r"D:\Photos\Bali").as_deref(), Some(r"D:\Photos"));
        assert_eq!(parent_of(r"D:\Photos").as_deref(), Some(r"D:\"));
        assert_eq!(file_name_of(r"D:\Photos\Bali\"), "Bali");
        assert_eq!(file_name_of(r"D:\"), r"D:");
    }
}
