# Changelog

Semua perubahan penting pada Framer dicatat dalam berkas ini.

Format mengikuti prinsip [Keep a Changelog](https://keepachangelog.com/id/1.1.0/), dengan deskripsi berbahasa Indonesia.

## [Unreleased]

> Bagian ini dibekukan. Isinya ditulis sebelum kebijakan append-only, tidak punya cap waktu, dan tidak diubah lagi. Entri baru dicatat di [Log append-only](#log-append-only) pada akhir berkas.

### feat

- Menambahkan Disk Usage Analyzer untuk membaca penggunaan ruang drive atau folder secara lokal.
- Menambahkan penjelajahan hierarki folder, daftar file terbesar, progres scan, pembatalan scan, serta rekomendasi pembersihan yang aman untuk ditinjau.

### fix

- Menghitung hard link NTFS satu kali berdasarkan Windows File ID agar total penggunaan disk tidak melebihi kapasitas fisik drive.
- Melewati symlink, junction, dan reparse point untuk mencegah traversal berulang atau melingkar.
- Mengecualikan `C:\Windows` dari analisis drive, sambil tetap menganalisis Program Files dan ProgramData.
- Menampilkan allocated size sebagai ukuran utama dan logical size sebagai pembanding.

### style

- Mengubah nama aplikasi dari Frame menjadi Framer dengan tagline “Your gallery on Windows 11”.

### perf

- Mempercepat analisis penggunaan disk: tiap file kini hanya dibuka satu kali untuk membaca Windows File ID dan allocated size, tidak lagi empat kali. Hasil dan angkanya tidak berubah.
- Menghapus pembacaan metadata ganda per entri; metadata dari hasil pembacaan folder dipakai ulang tanpa akses disk tambahan.
- Membuka file secara paralel (maksimal 8 thread) per kelompok 256 file, lalu menghitung hasilnya berurutan sesuai urutan folder agar dedupe hard link dan total tetap konsisten.

### docs

- Menambahkan aturan kontribusi dan prosedur commit/push pada `AGENTS.md`.

### test

- Menambahkan pengujian bahwa pembacaan paralel menjaga urutan hasil dan bahwa allocated size dari satu handle sama dengan `GetCompressedFileSizeW`.

### issue

- Untuk file biasa (bukan compressed/sparse), ukuran utama masih berupa ukuran logis dari `GetCompressedFileSizeW` dan belum dibulatkan ke cluster, sehingga total bisa lebih kecil daripada “Size on disk” di Explorer. Belum diubah agar angka tidak bergeser tanpa keputusan eksplisit.

## Aturan kategori

- `feat`: fitur baru yang dapat digunakan pengguna.
- `fix`: perbaikan bug atau hasil yang tidak akurat.
- `style`: perubahan tampilan, copy, atau identitas visual tanpa mengubah perilaku inti.
- `refactor`: perapian struktur internal tanpa perubahan perilaku pengguna.
- `perf`: peningkatan performa atau penggunaan memori.
- `docs`: perubahan dokumentasi atau panduan.
- `test`: penambahan atau perubahan pengujian.
- `build`: perubahan dependency, build, bundling, atau CI.
- `chore`: pemeliharaan rutin yang tidak masuk kategori lain.
- `issue`: masalah yang diketahui, batasan, atau tindak lanjut yang belum selesai.

## Log append-only

Entri hanya ditambahkan di akhir berkas, dikelompokkan per tanggal, dan memakai waktu lokal tepat hingga detik beserta offset zona waktu. Entri lama tidak boleh diubah atau dihapus; koreksi ditulis sebagai entri baru. Kategori mengikuti daftar di atas, ditambah `rilis` sebagai penanda versi. Aturan lengkap ada di `AGENTS.md`.

### 2026-10-16

- `08:48:54 +07:00` `docs` — Merevisi kebijakan changelog di `AGENTS.md`: kategori tetap, tetapi changelog kini append-only, dikelompokkan per tanggal, dan setiap entri memakai cap waktu tepat hingga detik.
- `08:52:25 +07:00` `docs` — Menambahkan `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, dan `SECURITY.md`, serta bagian Contributing dan License pada `README.md` dan tautan ke `CONTRIBUTING.md` dari `AGENTS.md`, agar repository siap dibuka sebagai proyek open source.
- `08:52:25 +07:00` `chore` — Menambahkan templat issue (laporan bug dan usulan fitur) serta templat pull request di `.github`, dan mencantumkan lisensi MIT pada `package.json`, `package-lock.json`, dan `src-tauri/Cargo.toml`.
- `09:23:03 +07:00` `docs` — Menambahkan dua draf artikel blog di `docs/articles/`: panduan mengecek file terbesar saat disk C penuh (dengan studi kasus cache CapCut) dan review Framer dibandingkan WizTree, WinDirStat, dan TreeSize, lengkap dengan screenshot yang sudah dipotong agar tidak memuat data pribadi.
- `09:23:03 +07:00` `issue` — File cloud placeholder seperti iCloud Drive dan OneDrive Files On-Demand bertanda reparse point sehingga dilewati scanner Disk Usage, termasuk yang sudah tersimpan di disk. Total bisa lebih kecil dari pemakaian sebenarnya. Belum diperbaiki.
- `09:28:54 +07:00` `chore` — Mengecualikan folder `docs/` dari Git lewat `.gitignore` dan melepaskan draf artikel dari pelacakan; berkasnya tetap ada di komputer lokal. Ini mengoreksi entri `09:23:03` yang mencatat draf artikel sebagai bagian dari repository.
- `09:28:54 +07:00` `docs` — Menambahkan aturan di `AGENTS.md` bahwa `docs/` hanya untuk lokal dan screenshot yang akan dipublikasikan wajib disensor dari path, nama folder pribadi, alamat email, dan identitas akun.
- `09:41:22 +07:00` `rilis` — Versi 0.1.0. Installer Windows 11 `Framer_0.1.0_x64-setup.exe` (SHA256 `982905C79A7C0F3B0E985D2A51E05FADE020E5F1B01D9BE7BBFA4DAF5F1E33A3`) tersedia di halaman Releases GitHub, dengan tag `v0.1.0` pada commit `23897a6`.
- `09:49:51 +07:00` `fix` — Hasil analisis Disk Usage kini tetap tersimpan saat pindah ke menu lain lalu kembali, sehingga tidak perlu memindai ulang dari awal. Scan yang sedang berjalan juga tidak lagi dibatalkan otomatis saat berpindah menu; scan hanya berhenti lewat tombol Cancel Scan.
- `09:49:51 +07:00` `feat` — Menambahkan tombol Scan Again pada hasil Disk Usage untuk memindai ulang lokasi yang sama, dan keterangan kapan scan terakhir selesai pada kartu Scan quality.
- `09:49:51 +07:00` `test` — Menambahkan 12 pengujian untuk penyimpanan hasil scan antar menu, pembatalan, scan yang saling menggantikan, dan penanganan error pada Disk Usage.
- `09:50:18 +07:00` `docs` — Menambahkan aturan di `AGENTS.md` bahwa commit dan deskripsi PR hanya memakai identitas Git pemilik repository, tanpa trailer `Co-Authored-By` atau atribusi asisten AI.
