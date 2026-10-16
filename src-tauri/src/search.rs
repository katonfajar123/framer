//! Turns what the user types in the search box into SQL conditions.
//!
//! Every whitespace-separated word must match (AND). A word that looks like a
//! year, month, date, file extension or media kind matches on that meaning *or*
//! as plain text in the file/folder name, so `Bali`, `2026`, `October`, `PNG`
//! and `videos` all behave the way people expect.

use crate::paths::like_escape;
use rusqlite::types::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Term {
    Year(i32),
    Month(u32),
    /// `2026-10` or `2026-10-24`, matched as a prefix of the local capture date.
    DatePrefix(String),
    Extension(Vec<&'static str>),
    Videos,
    Photos,
    Screenshots,
    Text(String),
}

const MONTHS: &[(&str, u32)] = &[
    ("january", 1),
    ("jan", 1),
    ("januari", 1),
    ("february", 2),
    ("feb", 2),
    ("februari", 2),
    ("march", 3),
    ("mar", 3),
    ("maret", 3),
    ("april", 4),
    ("apr", 4),
    ("may", 5),
    ("mei", 5),
    ("june", 6),
    ("jun", 6),
    ("juni", 6),
    ("july", 7),
    ("jul", 7),
    ("juli", 7),
    ("august", 8),
    ("aug", 8),
    ("agustus", 8),
    ("agu", 8),
    ("september", 9),
    ("sep", 9),
    ("sept", 9),
    ("october", 10),
    ("oct", 10),
    ("oktober", 10),
    ("okt", 10),
    ("november", 11),
    ("nov", 11),
    ("december", 12),
    ("dec", 12),
    ("desember", 12),
    ("des", 12),
];

fn extension_for(word: &str) -> Option<Vec<&'static str>> {
    let word = word.trim_start_matches('.');
    Some(match word {
        "jpg" | "jpeg" => vec!["jpg", "jpeg"],
        "png" => vec!["png"],
        "webp" => vec!["webp"],
        "gif" => vec!["gif"],
        "mp4" => vec!["mp4"],
        "mov" => vec!["mov"],
        "m4v" => vec!["m4v"],
        "webm" => vec!["webm"],
        _ => return None,
    })
}

fn tokenize(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in query.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                if !quoted && !current.is_empty() {
                    tokens.push(format!("\"{current}"));
                    current.clear();
                }
            }
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(if quoted {
            format!("\"{current}")
        } else {
            current
        });
    }
    tokens
}

pub fn parse(query: &str) -> Vec<Term> {
    tokenize(query)
        .into_iter()
        .map(|token| {
            if let Some(phrase) = token.strip_prefix('"') {
                return Term::Text(phrase.to_owned());
            }
            let word = token
                .trim_matches(|c: char| c == ',' || c == ';')
                .to_lowercase();
            if word.len() == 4 {
                if let Ok(year) = word.parse::<i32>() {
                    if (1900..=2100).contains(&year) {
                        return Term::Year(year);
                    }
                }
            }
            if let Some(prefix) = date_prefix(&word) {
                return Term::DatePrefix(prefix);
            }
            if let Some((_, month)) = MONTHS.iter().find(|(name, _)| *name == word) {
                return Term::Month(*month);
            }
            match word.as_str() {
                "video" | "videos" => return Term::Videos,
                "photo" | "photos" | "picture" | "pictures" => return Term::Photos,
                "screenshot" | "screenshots" => return Term::Screenshots,
                _ => {}
            }
            if let Some(extensions) = extension_for(&word) {
                return Term::Extension(extensions);
            }
            Term::Text(token)
        })
        .collect()
}

fn date_prefix(word: &str) -> Option<String> {
    let parts: Vec<&str> = word.split(['-', '/']).collect();
    if !(2..=3).contains(&parts.len()) || parts[0].len() != 4 {
        return None;
    }
    let year: i32 = parts[0].parse().ok()?;
    let month: u32 = parts[1].parse().ok()?;
    if !(1900..=2100).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    let mut prefix = format!("{year:04}-{month:02}");
    if let Some(day) = parts.get(2) {
        let day: u32 = day.parse().ok()?;
        if !(1..=31).contains(&day) {
            return None;
        }
        prefix.push_str(&format!("-{day:02}"));
    }
    Some(prefix)
}

fn text_match(text: &str, params: &mut Vec<Value>) -> String {
    let pattern = format!("%{}%", like_escape(text));
    params.push(Value::Text(pattern.clone()));
    params.push(Value::Text(pattern));
    "(m.file_name LIKE ? ESCAPE '!' OR m.folder_path LIKE ? ESCAPE '!')".to_owned()
}

const LOCAL_DATE: &str = "strftime('%Y-%m-%d', m.captured_at, 'unixepoch', 'localtime')";

/// SQL for one term, appending its bound parameters in order.
pub fn term_sql(term: &Term, params: &mut Vec<Value>) -> String {
    match term {
        Term::Year(year) => {
            params.push(Value::Integer(*year as i64));
            let text = text_match(&year.to_string(), params);
            format!("(CAST(strftime('%Y', m.captured_at, 'unixepoch', 'localtime') AS INTEGER) = ? OR {text})")
        }
        Term::Month(month) => {
            params.push(Value::Integer(*month as i64));
            let name = MONTHS
                .iter()
                .find(|(_, number)| number == month)
                .map(|(name, _)| *name)
                .unwrap_or_default();
            let text = text_match(name, params);
            format!("(CAST(strftime('%m', m.captured_at, 'unixepoch', 'localtime') AS INTEGER) = ? OR {text})")
        }
        Term::DatePrefix(prefix) => {
            params.push(Value::Text(format!("{prefix}%")));
            let text = text_match(prefix, params);
            format!("({LOCAL_DATE} LIKE ? OR {text})")
        }
        Term::Extension(extensions) => {
            let placeholders = vec!["?"; extensions.len()].join(",");
            for extension in extensions {
                params.push(Value::Text((*extension).to_owned()));
            }
            format!("m.extension IN ({placeholders})")
        }
        Term::Videos => "m.media_type = 'video'".to_owned(),
        Term::Photos => "m.media_type = 'photo'".to_owned(),
        Term::Screenshots => "m.screenshot = 1".to_owned(),
        Term::Text(text) => text_match(text, params),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_examples_from_the_product_brief() {
        assert_eq!(parse("sunset.jpg"), vec![Term::Text("sunset.jpg".into())]);
        assert_eq!(parse("Bali"), vec![Term::Text("Bali".into())]);
        assert_eq!(
            parse("October 2026"),
            vec![Term::Month(10), Term::Year(2026)]
        );
        assert_eq!(parse("PNG"), vec![Term::Extension(vec!["png"])]);
        assert_eq!(parse("2026"), vec![Term::Year(2026)]);
    }

    #[test]
    fn handles_dates_kinds_and_phrases() {
        assert_eq!(parse("2026-10"), vec![Term::DatePrefix("2026-10".into())]);
        assert_eq!(
            parse("2026/3/9"),
            vec![Term::DatePrefix("2026-03-09".into())]
        );
        assert_eq!(parse("videos"), vec![Term::Videos]);
        assert_eq!(
            parse("\"summer trip\""),
            vec![Term::Text("summer trip".into())]
        );
        assert_eq!(parse("1066"), vec![Term::Text("1066".into())]);
        assert!(parse("   ").is_empty());
    }

    #[test]
    fn sql_uses_placeholders_only() {
        let mut params = Vec::new();
        let sql = term_sql(&Term::Text("o'brien; DROP TABLE media".into()), &mut params);
        assert!(!sql.contains("DROP"));
        assert_eq!(params.len(), 2);
    }
}
