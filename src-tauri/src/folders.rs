use crate::{
    db::Db,
    error::{blocking, AppResult},
    paths::{file_name_of, parent_of, path_key},
};
use serde::Serialize;
use std::{collections::HashMap, path::Path};
use tauri::State;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
    pub source_id: i64,
    /// Items directly inside this folder.
    pub direct_count: i64,
    /// Items in this folder and everything below it.
    pub total_count: i64,
    pub is_root: bool,
    pub available: bool,
    /// A photo from this folder (or below) to use as its cover.
    pub cover_id: Option<i64>,
}

pub struct SourceInfo {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub available: bool,
}

/// One row per folder that directly contains media: (folder path, source id, item count, cover photo id).
pub type FolderRow = (String, i64, i64, Option<i64>);

/// Assemble the folder hierarchy for every source, including empty intermediate
/// folders, so the UI can show a real tree with breadcrumbs.
pub fn build_tree(sources: &[SourceInfo], folders: &[FolderRow]) -> Vec<FolderNode> {
    let mut nodes: HashMap<String, FolderNode> = HashMap::new();
    for source in sources {
        nodes.insert(
            path_key(Path::new(&source.path)),
            FolderNode {
                path: source.path.clone(),
                name: source.name.clone(),
                parent: None,
                source_id: source.id,
                direct_count: 0,
                total_count: 0,
                is_root: true,
                available: source.available,
                cover_id: None,
            },
        );
    }
    for (folder, source_id, count, cover) in folders {
        let Some(source) = sources.iter().find(|source| source.id == *source_id) else {
            continue;
        };
        let root_key = path_key(Path::new(&source.path));
        let mut current = folder.clone();
        let mut first = true;
        loop {
            let key = path_key(Path::new(&current));
            if !nodes.contains_key(&key) {
                nodes.insert(
                    key.clone(),
                    FolderNode {
                        name: file_name_of(&current),
                        parent: parent_of(&current),
                        path: current.clone(),
                        source_id: *source_id,
                        direct_count: 0,
                        total_count: 0,
                        is_root: false,
                        available: source.available,
                        cover_id: None,
                    },
                );
            }
            if first {
                if let Some(node) = nodes.get_mut(&key) {
                    node.direct_count += count;
                    node.cover_id = node.cover_id.max(*cover);
                }
                first = false;
            }
            if key == root_key {
                break;
            }
            match parent_of(&current) {
                Some(parent) => current = parent,
                None => break,
            }
        }
    }
    // Roll totals and covers up from the deepest folders to the roots.
    let mut keys: Vec<String> = nodes.keys().cloned().collect();
    for node in nodes.values_mut() {
        node.total_count = node.direct_count;
    }
    keys.sort_by_key(|key| std::cmp::Reverse(key.len()));
    for key in keys {
        let Some(node) = nodes.get(&key).cloned() else {
            continue;
        };
        let Some(parent) = node.parent else { continue };
        if let Some(parent_node) = nodes.get_mut(&path_key(Path::new(&parent))) {
            parent_node.total_count += node.total_count;
            parent_node.cover_id = parent_node.cover_id.max(node.cover_id);
        }
    }
    let mut result: Vec<FolderNode> = nodes.into_values().collect();
    result.sort_by(|a, b| {
        (a.source_id, path_key(Path::new(&a.path)))
            .cmp(&(b.source_id, path_key(Path::new(&b.path))))
    });
    result
}

#[tauri::command]
pub async fn folder_tree(db: State<'_, Db>) -> AppResult<Vec<FolderNode>> {
    let db = db.inner().clone();
    blocking(move || {
        let connection = db.connect()?;
        let sources = {
            let mut statement = connection.prepare("SELECT id, path, name FROM sources ORDER BY created_at, id")?;
            let rows = statement
                .query_map([], |row| {
                    let path: String = row.get(1)?;
                    Ok(SourceInfo { id: row.get(0)?, available: Path::new(&path).is_dir(), path, name: row.get(2)? })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let folders = {
            let mut statement = connection.prepare(
                "SELECT folder_path, source_id, COUNT(*), MAX(CASE WHEN media_type = 'photo' THEN id END)
                 FROM media GROUP BY folder_path, source_id",
            )?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        Ok(build_tree(&sources, &folders))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: i64, path: &str, name: &str) -> SourceInfo {
        SourceInfo {
            id,
            path: path.into(),
            name: name.into(),
            available: true,
        }
    }

    #[test]
    fn builds_a_tree_with_empty_intermediate_folders_and_rolled_up_totals() {
        let sources = vec![
            source(1, r"D:\Photos", "Photos"),
            source(2, r"E:\Backup", "Backup"),
        ];
        let folders: Vec<FolderRow> = vec![
            (r"D:\Photos".into(), 1, 2, Some(1)),
            (r"D:\Photos\Trips\Bali".into(), 1, 5, Some(9)),
            (r"D:\Photos\Trips\Lombok".into(), 1, 3, None),
            (r"E:\Backup\2020".into(), 2, 4, Some(20)),
        ];
        let tree = build_tree(&sources, &folders);
        let find = |path: &str| {
            tree.iter()
                .find(|node| node.path == path)
                .unwrap_or_else(|| panic!("missing {path}"))
        };

        let root = find(r"D:\Photos");
        assert!(root.is_root && root.parent.is_none());
        assert_eq!((root.direct_count, root.total_count), (2, 10));
        assert_eq!(root.cover_id, Some(9));

        let trips = find(r"D:\Photos\Trips");
        assert_eq!(
            (trips.direct_count, trips.total_count),
            (0, 8),
            "intermediate folder with no photos of its own"
        );
        assert_eq!(trips.parent.as_deref(), Some(r"D:\Photos"));
        assert_eq!(trips.name, "Trips");

        assert_eq!(
            find(r"D:\Photos\Trips\Lombok").parent.as_deref(),
            Some(r"D:\Photos\Trips")
        );
        let backup = find(r"E:\Backup");
        assert_eq!(backup.total_count, 4);
        assert_eq!(tree.len(), 6);
    }

    #[test]
    fn empty_sources_still_appear_as_roots() {
        let tree = build_tree(&[source(1, r"D:\Photos", "Photos")], &[]);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].total_count, 0);
    }

    #[test]
    fn ignores_folders_from_unknown_sources() {
        let tree = build_tree(
            &[source(1, r"D:\Photos", "Photos")],
            &[(r"Z:\Ghost".into(), 99, 1, None)],
        );
        assert_eq!(tree.len(), 1);
    }
}
