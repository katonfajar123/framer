use chrono::{Local, NaiveDate, TimeZone};
use exif::{In, Tag, Value};
use serde::Serialize;
use std::{fs::File, io::BufReader, path::Path};

/// The few EXIF facts the indexer needs for every photo.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExifBasics {
    /// Moment the photo was taken (unix seconds), interpreting the EXIF clock as local time.
    pub captured_at: Option<i64>,
    /// EXIF orientation 1..=8 (1 = upright). 0 when unknown.
    pub orientation: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MetaField {
    pub label: String,
    pub value: String,
}

fn open_exif(path: &Path) -> Option<exif::Exif> {
    let file = File::open(path).ok()?;
    exif::Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .ok()
}

fn read_date(exif: &exif::Exif) -> Option<i64> {
    for tag in [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime] {
        let Some(field) = exif.get_field(tag, In::PRIMARY) else {
            continue;
        };
        let Value::Ascii(parts) = &field.value else {
            continue;
        };
        let Some(bytes) = parts.first() else { continue };
        let Ok(stamp) = exif::DateTime::from_ascii(bytes) else {
            continue;
        };
        let Some(date) =
            NaiveDate::from_ymd_opt(stamp.year as i32, stamp.month as u32, stamp.day as u32)
        else {
            continue;
        };
        let Some(naive) =
            date.and_hms_opt(stamp.hour as u32, stamp.minute as u32, stamp.second as u32)
        else {
            continue;
        };
        if let Some(local) = Local.from_local_datetime(&naive).earliest() {
            return Some(local.timestamp());
        }
    }
    None
}

fn read_orientation(exif: &exif::Exif) -> u16 {
    exif.get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .filter(|value| (1..=8).contains(value))
        .map(|value| value as u16)
        .unwrap_or(0)
}

pub fn read_basics(path: &Path) -> ExifBasics {
    match open_exif(path) {
        Some(exif) => ExifBasics {
            captured_at: read_date(&exif),
            orientation: read_orientation(&exif),
        },
        None => ExifBasics::default(),
    }
}

/// Human-readable EXIF rows for the metadata inspector.
pub fn read_details(path: &Path) -> Vec<MetaField> {
    let Some(exif) = open_exif(path) else {
        return Vec::new();
    };
    let text = |tag: Tag| -> Option<String> {
        exif.get_field(tag, In::PRIMARY).map(|field| {
            field
                .display_value()
                .with_unit(&exif)
                .to_string()
                .trim_matches('"')
                .trim()
                .to_owned()
        })
    };
    let mut rows = Vec::new();
    let mut push = |label: &str, value: Option<String>| {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            rows.push(MetaField {
                label: label.to_owned(),
                value,
            });
        }
    };
    let camera = match (text(Tag::Make), text(Tag::Model)) {
        (Some(make), Some(model)) if model.starts_with(&make) => Some(model),
        (Some(make), Some(model)) => Some(format!("{make} {model}")),
        (None, Some(model)) => Some(model),
        (Some(make), None) => Some(make),
        (None, None) => None,
    };
    push("Camera", camera);
    push("Lens", text(Tag::LensModel));
    push("Focal length", text(Tag::FocalLength));
    push("Aperture", text(Tag::FNumber));
    push("Shutter", text(Tag::ExposureTime));
    push("ISO", text(Tag::PhotographicSensitivity));
    push("Flash", text(Tag::Flash));
    push("Software", text(Tag::Software));
    rows
}

#[cfg(test)]
pub mod test_support {
    /// Build a minimal JPEG that carries an EXIF block (Orientation, DateTimeOriginal,
    /// Make, Model) in front of the real image data, for tests.
    pub fn jpeg_with_exif(
        jpeg: &[u8],
        orientation: u16,
        date: &str,
        make: &str,
        model: &str,
    ) -> Vec<u8> {
        fn ascii(value: &str) -> Vec<u8> {
            let mut bytes = value.as_bytes().to_vec();
            bytes.push(0);
            bytes
        }
        // (tag, type, count, payload) — payload is inline when <= 4 bytes, otherwise offset.
        let make_bytes = ascii(make);
        let model_bytes = ascii(model);
        let date_bytes = ascii(date);
        assert_eq!(
            date_bytes.len(),
            20,
            "EXIF date must be 'YYYY:MM:DD HH:MM:SS'"
        );

        // IFD0 has 4 entries: Make, Model, Orientation, ExifIFDPointer.
        let ifd0_offset = 8u32;
        let ifd0_len = 2 + 4 * 12 + 4;
        let mut data_offset = ifd0_offset + ifd0_len as u32;
        let make_off = data_offset;
        data_offset += make_bytes.len() as u32 + (make_bytes.len() as u32 % 2);
        let model_off = data_offset;
        data_offset += model_bytes.len() as u32 + (model_bytes.len() as u32 % 2);
        let exif_ifd_off = data_offset;
        let exif_ifd_len = 2 + 12 + 4;
        let date_off = exif_ifd_off + exif_ifd_len as u32;

        let mut tiff: Vec<u8> = Vec::new();
        tiff.extend_from_slice(b"MM\x00\x2a");
        tiff.extend_from_slice(&ifd0_offset.to_be_bytes());
        tiff.extend_from_slice(&4u16.to_be_bytes());
        let entry = |tag: u16, kind: u16, count: u32, value: [u8; 4]| {
            let mut out = Vec::new();
            out.extend_from_slice(&tag.to_be_bytes());
            out.extend_from_slice(&kind.to_be_bytes());
            out.extend_from_slice(&count.to_be_bytes());
            out.extend_from_slice(&value);
            out
        };
        tiff.extend(entry(
            0x010F,
            2,
            make_bytes.len() as u32,
            make_off.to_be_bytes(),
        ));
        tiff.extend(entry(
            0x0110,
            2,
            model_bytes.len() as u32,
            model_off.to_be_bytes(),
        ));
        let mut orient = [0u8; 4];
        orient[..2].copy_from_slice(&orientation.to_be_bytes());
        tiff.extend(entry(0x0112, 3, 1, orient));
        tiff.extend(entry(0x8769, 4, 1, exif_ifd_off.to_be_bytes()));
        tiff.extend_from_slice(&0u32.to_be_bytes());
        tiff.extend_from_slice(&make_bytes);
        if make_bytes.len() % 2 == 1 {
            tiff.push(0);
        }
        tiff.extend_from_slice(&model_bytes);
        if model_bytes.len() % 2 == 1 {
            tiff.push(0);
        }
        tiff.extend_from_slice(&1u16.to_be_bytes());
        tiff.extend(entry(
            0x9003,
            2,
            date_bytes.len() as u32,
            date_off.to_be_bytes(),
        ));
        tiff.extend_from_slice(&0u32.to_be_bytes());
        tiff.extend_from_slice(&date_bytes);

        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend_from_slice(&tiff);
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpeg[2..]); // skip original SOI
        out
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::jpeg_with_exif;
    use super::*;
    use image::{codecs::jpeg::JpegEncoder, RgbImage};

    fn plain_jpeg() -> Vec<u8> {
        let image = RgbImage::from_pixel(8, 4, image::Rgb([200, 30, 30]));
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 80)
            .encode_image(&image)
            .unwrap();
        bytes
    }

    #[test]
    fn reads_date_and_orientation_from_exif() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        std::fs::write(
            &path,
            jpeg_with_exif(
                &plain_jpeg(),
                6,
                "2024:03:09 18:30:15",
                "Pentax",
                "Pentax 17",
            ),
        )
        .unwrap();
        let basics = read_basics(&path);
        assert_eq!(basics.orientation, 6);
        let expected = Local
            .with_ymd_and_hms(2024, 3, 9, 18, 30, 15)
            .earliest()
            .unwrap()
            .timestamp();
        assert_eq!(basics.captured_at, Some(expected));
        let details = read_details(&path);
        assert!(details
            .iter()
            .any(|row| row.label == "Camera" && row.value == "Pentax 17"));
    }

    #[test]
    fn plain_files_have_no_exif() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.jpg");
        std::fs::write(&path, plain_jpeg()).unwrap();
        assert_eq!(read_basics(&path), ExifBasics::default());
        assert!(read_details(&path).is_empty());
    }
}
