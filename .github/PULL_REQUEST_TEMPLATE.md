## Ringkasan

<!-- Apa yang berubah dan mengapa? Sertakan nomor issue bila ada, mis. "Menutup #12". -->

## Jenis perubahan

<!-- Hapus yang tidak relevan. -->

`feat` · `fix` · `style` · `refactor` · `perf` · `docs` · `test` · `build` · `chore`

## Validasi

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run test:rust`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`
- [ ] Sudah dicoba langsung di aplikasi (untuk perubahan UI atau perilaku)

<!-- Tulis hasil atau catatan penting, mis. ukuran folder uji dan waktu sebelum/sesudah untuk perubahan performa. -->

## Daftar periksa

- [ ] Scope PR kecil dan hanya mengerjakan satu hal
- [ ] `CHANGELOG.md` ditambah **di akhir** `## Log append-only` dengan cap waktu hingga detik, dan `git diff --numstat CHANGELOG.md` menunjukkan 0 baris dihapus
- [ ] Pesan commit mengikuti format `<tipe>(<scope>): <ringkasan bahasa Indonesia>`
- [ ] Tidak ada secret, `.env`, database lokal, cache, build output, atau data media pengguna
- [ ] Tidak menambah dependency, atau alasannya dijelaskan di atas
- [ ] Disk Usage tetap hanya membaca dan tidak mengubah file pengguna

## Tangkapan layar

<!-- Untuk perubahan tampilan. Samarkan path atau nama pribadi. -->
