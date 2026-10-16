# Panduan Kontributor — Framer

Terima kasih sudah tertarik berkontribusi pada Framer, galeri foto dan video lokal untuk Windows 11. Semua bentuk kontribusi diterima: laporan bug, usulan fitur, perbaikan dokumentasi, dan kode.

Dengan ikut berpartisipasi, kamu setuju mengikuti [Kode Etik](CODE_OF_CONDUCT.md). Untuk kerentanan keamanan, jangan buka issue publik; ikuti [SECURITY.md](SECURITY.md).

## Prinsip proyek

Perubahan akan lebih mudah diterima bila sejalan dengan prinsip berikut:

- **Local-first.** Framer tidak mengimpor, menyalin, atau mengunggah file pengguna.
- **Disk Usage hanya membaca.** Analisis disk tidak boleh menghapus atau mengubah file apa pun.
- **Penghapusan harus eksplisit dan bisa dipulihkan.** Satu-satunya aksi penghapusan adalah _Move to Recycle Bin_ yang dikonfirmasi pengguna.
- **Ringan.** UI sengaja tanpa framework dan dependency dijaga seminimal mungkin. Tambahan dependency perlu alasan yang jelas di deskripsi PR.

## Sebelum mulai

- Cari dulu di [issue yang sudah ada](https://github.com/katonfajar123/framer/issues) agar tidak ada pekerjaan ganda.
- Untuk perubahan besar atau yang mengubah perilaku aplikasi, buka issue dan diskusikan dulu sebelum menulis kode.
- Satu PR sebaiknya mengerjakan satu hal. Scope kecil lebih cepat ditinjau.

## Menyiapkan lingkungan

Kebutuhan: Windows 11, [Rust](https://rustup.rs) (toolchain MSVC), Node.js 20+, dan WebView2 runtime (sudah bawaan Windows 11).

```powershell
git clone https://github.com/<akun-kamu>/framer.git
cd framer
npm install
npm run desktop          # tauri dev: Vite + Rust dengan hot reload
```

## Alur kontribusi

1. Fork repository, lalu buat branch dari `main` dengan nama `<tipe>/<ringkasan-singkat>`, misalnya `fix/scanner-junction`.
2. Kerjakan perubahan dengan scope sekecil mungkin.
3. Jalankan validasi (lihat di bawah). Semuanya harus lulus.
4. Catat perubahan di `CHANGELOG.md` sesuai kebijakan append-only.
5. Commit dengan format Conventional Commits berbahasa Indonesia.
6. Push ke fork kamu dan buka Pull Request ke `main`. Isi templat PR sampai selesai.

> `AGENTS.md` mewajibkan `git push origin HEAD`. Untuk pemelihara dan agen, `origin` adalah repository utama. Untuk kontributor eksternal, `origin` adalah fork kamu; cukup push ke sana lalu buka PR.

## Validasi

```powershell
npm run check            # tsc --noEmit
npm test                 # logika TypeScript (vitest)
npm run test:rust        # indexer, pencarian, EXIF, thumbnail, watcher, migrasi
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
```

Saat ini seluruh repo bersih dari selisih `cargo fmt` dan peringatan `clippy`. Jaga agar tetap begitu. Kalau kamu mengubah perilaku, tambahkan atau perbarui test-nya.

## Commit

Gunakan Conventional Commits dengan ringkasan berbahasa Indonesia:

```text
<tipe>(<scope>): <ringkasan>
```

Tipe yang diizinkan: `feat`, `fix`, `style`, `refactor`, `perf`, `docs`, `test`, `build`, dan `chore`. Contoh:

- `feat(disk): hitung hard link satu kali`
- `fix(scanner): lewati junction Windows`
- `docs(changelog): catat aturan rilis`

## Changelog

Setiap perubahan kode, konfigurasi, dependency, dokumentasi, atau aset **wajib** dicatat di `CHANGELOG.md`. Ringkasnya:

- Log bersifat **append-only**: tambahkan entri di akhir bagian `## Log append-only`. Jangan mengubah, menghapus, atau memindahkan entri yang sudah ada.
- Entri dikelompokkan per tanggal (`### YYYY-MM-DD`) dan memakai waktu lokal tepat hingga detik beserta offset zona waktu, diambil dari jam sistem saat menulis:

  ```powershell
  Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
  ```

- Format satu entri: ``- `HH:mm:ss ±hh:mm` `kategori` — Deskripsi singkat berbahasa Indonesia.``
- Periksa bahwa `git diff --numstat CHANGELOG.md` menunjukkan **0** baris dihapus.

Aturan lengkap, termasuk pencatatan rilis, ada di [AGENTS.md](AGENTS.md).

## Data pribadi

Jangan pernah menyertakan hal berikut di commit, issue, PR, maupun screenshot:

- secret, token, atau file `.env`;
- database lokal (`*.db`), cache, thumbnail, atau build output;
- foto, video, atau data media milik pengguna;
- path yang memuat nama atau informasi pribadi (samarkan sebelum membagikan log atau screenshot).

## Lisensi kontribusi

Framer dirilis di bawah [Lisensi MIT](LICENSE). Dengan mengirim kontribusi, kamu menyatakan bahwa kamu berhak melakukannya dan bahwa kontribusimu dilisensikan di bawah lisensi yang sama.

## Kontribusi dengan bantuan AI

Boleh memakai agen atau asisten AI. Agen wajib mengikuti [AGENTS.md](AGENTS.md), dan kontributor tetap bertanggung jawab penuh atas isi PR: pahami, jalankan, dan uji sendiri perubahan yang dikirim.
