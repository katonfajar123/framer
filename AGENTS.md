# Aturan Kerja Agen — Framer

Dokumen ini berlaku untuk setiap agen atau kontributor yang mengubah repository ini. Panduan untuk kontributor umum ada di [CONTRIBUTING.md](CONTRIBUTING.md); bila ada perbedaan, dokumen ini yang berlaku.

## Aturan wajib

1. Setiap perubahan kode, konfigurasi, dependency, dokumentasi, aset, atau perilaku aplikasi **wajib** dicatat di `CHANGELOG.md` dalam bahasa Indonesia, secara **append-only** dengan tanggal dan waktu tepat hingga detik (lihat [Aturan changelog](#aturan-changelog)).
2. Setiap perubahan yang sudah diverifikasi **wajib** dibuatkan commit Git sebelum pekerjaan dianggap selesai.
3. Setiap commit yang dibuat **wajib** di-push ke remote branch yang sesuai sebelum handoff ke pengguna.
4. Jangan memasukkan secret, token, file `.env`, database lokal, cache, build output, atau data media pengguna ke commit.
5. Jangan mengubah atau menghapus file milik pengguna di luar scope tugas tanpa instruksi eksplisit.

## Urutan kerja

1. Jalankan `git status --short` dan periksa perubahan yang sudah ada sebelum mulai bekerja.
2. Implementasikan perubahan dengan scope sekecil mungkin.
3. Jalankan validasi yang relevan, minimal type check atau test yang terkait.
4. Tambahkan entri baru di **akhir** bagian `## Log append-only` pada `CHANGELOG.md` dengan kategori yang tepat. Ambil waktunya dari jam sistem tepat saat menulis entri:

   ```powershell
   Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
   ```

5. Tinjau perubahan dengan `git diff --check` dan `git diff --cached` sebelum commit. Pastikan `git diff --numstat CHANGELOG.md` menunjukkan **0** baris dihapus.
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

Kategori tetap sama (`feat`, `fix`, `style`, `refactor`, `perf`, `docs`, `test`, `build`, `chore`, dan `issue`), tetapi changelog kini berupa log **append-only** yang dikelompokkan per tanggal dan memakai cap waktu tepat hingga detik.

### Append-only

- Entri **hanya ditambahkan di akhir** bagian `## Log append-only`. Jangan mengubah, menghapus, memindahkan, atau mengurutkan ulang entri yang sudah ada, termasuk yang sudah di-commit atau di-push.
- Entri yang salah atau perlu diluruskan dikoreksi dengan **entri baru** yang menyebut cap waktu entri lama, bukan dengan menyunting entri lama.
- Sebelum commit, `git diff --numstat CHANGELOG.md` harus menunjukkan 0 baris dihapus.
- Bagian `## [Unreleased]` di bagian atas berkas dibekukan. Isinya ditulis sebelum kebijakan ini, tidak punya cap waktu, dan tidak diubah lagi.

### Pengelompokan per tanggal

- Setiap tanggal punya satu heading `### YYYY-MM-DD` di dalam `## Log append-only`.
- Jika tanggal sudah berganti, tambahkan heading tanggal baru di akhir berkas. Jika masih tanggal yang sama dengan heading terakhir, tambahkan entri di bawahnya.

### Format entri

Satu entri satu baris, satu kategori:

```md
- `HH:mm:ss ±hh:mm` `kategori` — Deskripsi singkat berbahasa Indonesia.
```

Contoh:

```md
### 2026-10-16

- `08:52:31 +07:00` `perf` — Mempercepat analisis disk dengan membuka tiap file satu kali.
```

- Waktu adalah waktu lokal mesin beserta offset zona waktunya, diambil dari jam sistem saat entri ditulis. Jangan dikarang, dibulatkan, atau disalin dari entri lain.
- Urutan waktu tidak boleh mundur: waktu entri baru harus sama dengan atau lebih akhir daripada entri sebelumnya.
- Perubahan yang mencakup beberapa kategori ditulis sebagai beberapa entri.
- Tulis deskripsi singkat, jelas, dan berbahasa Indonesia dari sudut pandang pengguna atau pemelihara. Jangan menulis detail internal yang tidak berguna bagi pembaca changelog.

### Rilis

Jangan memindahkan entri. Rilis dicatat dengan menambahkan satu entri penanda di akhir log:

```md
- `HH:mm:ss ±hh:mm` `rilis` — Versi 0.2.0.
```

Semua entri di atas penanda (sejak penanda rilis sebelumnya) termasuk dalam versi itu. Entri sesudahnya belum dirilis.

## Bila commit atau push gagal

Jangan mengklaim pekerjaan sudah selesai. Jelaskan penyebabnya, sertakan perintah atau error yang relevan, dan tinggalkan tree kerja dalam keadaan aman. Jika remote atau autentikasi belum tersedia, minta pengguna menyelesaikannya lalu lanjutkan push.
