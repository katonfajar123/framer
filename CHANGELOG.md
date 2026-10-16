# Changelog

Semua perubahan penting pada Framer dicatat dalam berkas ini.

Format mengikuti prinsip [Keep a Changelog](https://keepachangelog.com/id/1.1.0/), dengan deskripsi berbahasa Indonesia.

## [Unreleased]

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
