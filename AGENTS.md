# Aturan Kerja Agen — Framer

Dokumen ini berlaku untuk setiap agen atau kontributor yang mengubah repository ini.

## Aturan wajib

1. Setiap perubahan kode, konfigurasi, dependency, dokumentasi, aset, atau perilaku aplikasi **wajib** dicatat di `CHANGELOG.md` dalam bahasa Indonesia.
2. Setiap perubahan yang sudah diverifikasi **wajib** dibuatkan commit Git sebelum pekerjaan dianggap selesai.
3. Setiap commit yang dibuat **wajib** di-push ke remote branch yang sesuai sebelum handoff ke pengguna.
4. Jangan memasukkan secret, token, file `.env`, database lokal, cache, build output, atau data media pengguna ke commit.
5. Jangan mengubah atau menghapus file milik pengguna di luar scope tugas tanpa instruksi eksplisit.

## Urutan kerja

1. Jalankan `git status --short` dan periksa perubahan yang sudah ada sebelum mulai bekerja.
2. Implementasikan perubahan dengan scope sekecil mungkin.
3. Jalankan validasi yang relevan, minimal type check atau test yang terkait.
4. Perbarui bagian `## [Unreleased]` di `CHANGELOG.md` menggunakan kategori yang tepat.
5. Tinjau perubahan dengan `git diff --check` dan `git diff --cached` sebelum commit.
6. Buat commit, lalu push ke branch aktif:

   ```powershell
   git add <file-yang-berubah>
   git commit -m "<tipe>(<scope>): <ringkasan bahasa Indonesia>"
   git push origin HEAD
   ```

7. Laporkan hash commit dan hasil push pada handoff.

## Format commit

Gunakan Conventional Commits dengan ringkasan berbahasa Indonesia:

- `feat(disk): hitung hard link satu kali`
- `fix(scanner): lewati junction Windows`
- `style(brand): ubah nama aplikasi menjadi Framer`
- `docs(changelog): catat aturan rilis`
- `test(disk): uji identitas hard link`
- `build(deps): perbarui dependency pengujian`

Tipe yang diizinkan: `feat`, `fix`, `style`, `refactor`, `perf`, `docs`, `test`, `build`, dan `chore`.

## Aturan changelog

- Semua entri baru masuk ke `## [Unreleased]` sampai rilis dibuat.
- Gunakan heading `### feat`, `### fix`, `### style`, `### refactor`, `### perf`, `### docs`, `### test`, `### build`, `### chore`, atau `### issue`.
- Tulis deskripsi singkat, jelas, dan berbahasa Indonesia dari sudut pandang pengguna atau pemelihara.
- Jangan menulis detail internal yang tidak berguna bagi pembaca changelog.
- Untuk rilis, pindahkan entri `Unreleased` ke versi bertanggal, misalnya `## [0.2.0] - 2026-10-16`.

## Bila commit atau push gagal

Jangan mengklaim pekerjaan sudah selesai. Jelaskan penyebabnya, sertakan perintah atau error yang relevan, dan tinggalkan tree kerja dalam keadaan aman. Jika remote atau autentikasi belum tersedia, minta pengguna menyelesaikannya lalu lanjutkan push.
