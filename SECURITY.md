# Kebijakan Keamanan

## Versi yang didukung

Perbaikan keamanan hanya diberikan untuk versi terbaru pada branch `main`.

| Versi                 | Didukung |
| --------------------- | -------- |
| `main` / 0.1.x        | Ya       |
| Versi yang lebih lama | Tidak    |

## Melaporkan kerentanan

**Jangan membuka issue publik untuk kerentanan keamanan.**

Laporkan secara privat lewat fitur _private vulnerability reporting_ GitHub: buka tab **Security** pada repository ini, lalu pilih **Report a vulnerability**.

Sertakan sebanyak mungkin informasi berikut:

- deskripsi masalah dan dampaknya;
- langkah untuk mereproduksi, atau _proof of concept_ yang minimal;
- versi Framer dan versi Windows yang dipakai;
- saran perbaikan, bila ada.

Jangan menyertakan foto, video, atau data pribadi sungguhan dalam laporan. Gunakan file uji.

## Yang akan terjadi setelah melapor

Pemelihara akan berusaha menanggapi laporan dalam waktu yang wajar, mengonfirmasi masalahnya, dan mengabarkan perkembangan perbaikan. Ini proyek yang dikelola secara sukarela, sehingga tidak ada jaminan waktu tanggapan. Bila laporan valid, perbaikan dirilis lebih dulu dan pelapor dapat dicantumkan sebagai penemu, kecuali meminta tidak disebut.

Mohon beri waktu untuk memperbaiki sebelum mengungkapkan detail kerentanan secara publik.

## Cakupan

Framer berjalan sepenuhnya secara lokal dan tidak mengunggah file pengguna. Hal yang paling relevan untuk dilaporkan antara lain:

- aksi yang dapat menghapus, mengubah, atau membaca file di luar folder yang ditambahkan pengguna;
- akses ke berkas lokal lewat protokol `framer-thumb://` atau `asset:` di luar cakupan yang diizinkan;
- eksekusi perintah atau injeksi lewat nama file, path, atau kotak pencarian;
- kebocoran data lokal, seperti isi database indeks atau path pribadi, ke luar mesin pengguna;
- analisis Disk Usage yang melakukan perubahan, padahal seharusnya hanya membaca.

Masalah non-keamanan, seperti bug biasa atau permintaan fitur, silakan laporkan lewat [issue](https://github.com/katonfajar123/framer/issues).
