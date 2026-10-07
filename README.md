# Newproduksi — PHP native + MySQL

Backend menggunakan PHP native dengan PDO MySQL, tanpa Laravel, framework lain,
Composer, atau server Node.js. Tampilan HTML, CSS, JavaScript, dan aset tetap
menggunakan tampilan aplikasi sebelumnya. Endpoint frontend tetap `/api/production`.
Semua akun, token sesi, master, data produksi, pengaturan, dan foto APD disimpan
pada MySQL. Google Apps Script tidak digunakan saat aplikasi berjalan.

## Persiapan

- PHP 8.2+ dengan ekstensi `pdo_mysql`, `mbstring`, `iconv`, dan dukungan JSON.
- MySQL 8+.
- Buat database `newproduksi` dengan charset `utf8mb4` dan akun MySQL khusus.
  Proses setup membutuhkan izin CREATE, SELECT, INSERT, UPDATE, DELETE, REFERENCES.
  Setelah setup, akun runtime cukup SELECT, INSERT, UPDATE, DELETE.

```sql
CREATE DATABASE newproduksi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

1. Salin `.env.example` menjadi `.env` lalu isi koneksi MySQL.
2. Jalankan `php bin/console.php setup` untuk membuat tabel. Perintah ini tidak
   menghapus data yang sudah ada. Jika tabel lama `master_values` tersedia,
   master diimpor tanpa menimpa nilai yang sudah ada.
3. Isi `ADMIN_PASSWORD` di `.env` dengan password minimal 12 karakter, kemudian
   jalankan `php bin/console.php admin`. Akun yang sudah ada tidak ditimpa.
4. Hapus nilai `ADMIN_PASSWORD` dari `.env` setelah administrator dibuat.
5. Jalankan server lokal:

```powershell
php -S 127.0.0.1:8000 -t public router.php
```

Buka http://127.0.0.1:8000/login.html. Pada terminal Windows yang belum memiliki
PHP di PATH, gunakan `powershell -File tools/php.ps1` sebagai pengganti `php`.
Helper tersebut mencari PHP pada PATH atau instalasi Laragon.

Master database baru kosong; tambahkan operator, produk, dan botol melalui menu
pengaturan atau impor snapshot sebelum membuat SPK.

## Apache / Laragon

Atur DocumentRoot virtual host ke folder `newproduksi/public`, aktifkan
`mod_rewrite` dan `AllowOverride All`. Gunakan domain virtual host untuk aplikasi
ini karena URL API berasal dari root domain. Jangan arahkan DocumentRoot ke
folder proyek. File `.env`, kode backend, arsip lama, dan alat CLI berada di luar
folder publik. Gunakan HTTPS saat aplikasi diakses melalui jaringan produksi.
Server bawaan `php -S` digunakan untuk pengembangan lokal.

## Struktur

- `public/`: delapan halaman HTML, CSS, JavaScript, gambar, dan endpoint PHP.
- `app/Services/`: login, hak akses, SPK, Filling, Press, APD, dan saldo produksi.
- `app/Database.php`: koneksi PDO dan kueri dengan parameter terikat.
- `app/Http/Controllers/ProductionController.php`: pemetaan action API.
- `bootstrap.php`: pemuatan konfigurasi dan kelas aplikasi tanpa dependency.
- `database/schema.sql`: skema MySQL.
- `bin/console.php`: setup, pembuatan administrator, dan impor snapshot.

Berkas Laravel sebelumnya disimpan lokal dalam `.legacy-laravel/` untuk pemulihan.
Folder tersebut diabaikan Git dan tidak dimuat oleh aplikasi. `Code.gs` serta tes
JavaScript lama hanya referensi perilaku aplikasi sebelumnya.

## Tabel seperti spreadsheet

Data aplikasi disimpan pada tabel terpisah dengan kolom data yang dapat dibaca
langsung melalui database manager:

| Sheet / data | Tabel MySQL |
| --- | --- |
| Master | `production_master` |
| Pengerjaan Filling dan Press | `production_entries` (dibedakan oleh `tab`) |
| SPK | `production_spk` |
| APD | `production_apd` (setiap skor mempunyai kolom sendiri) |
| Penutupan Press | `production_press_adjustments` |
| Audit Hapus Pengerjaan | `production_entry_audits` |
| Down Time | `production_downtime` |
| Settings KPI | `production_settings` |
| Users / Sessions / Foto | `production_users` / `production_tokens` / `production_photos` |

Sisa Press dihitung dari pengerjaan dan penutupan oleh aplikasi; tidak disimpan
sebagai tabel salinan. Kolom `extra` hanya menyimpan atribut tambahan dari snapshot
yang belum dikenal; data utama memakai kolom tersendiri. Daftar ID foto tetap JSON.

Untuk database versi lama, hentikan server aplikasi sementara, lalu jalankan
`php bin/console.php setup` sebelum menjalankan kode baru. Setup menyalin isi
`production_records` ke tabel tujuan dalam satu transaksi, mempertahankan urutan
record, dan menandai migrasi selesai di `production_migrations`. Data lama tidak
dihapus, tetapi tabel tersebut tidak lagi dibaca/ditulis aplikasi. Jangan gunakan
kode versi lama setelah migrasi. Menjalankan setup ulang tidak menyalin ulang data.
Jika jenis record tidak dikenal atau ID tujuan bertabrakan, migrasi dibatalkan
tanpa menimpa data; tabel tujuan yang baru dibuat tetap tersedia untuk pemeriksaan.

## Impor snapshot spreadsheet

Gunakan `tools/export-php.gs` di proyek Apps Script lama untuk menghasilkan
snapshot JSON. Validasi dahulu, kemudian terapkan ke database produksi kosong:

```powershell
php bin/console.php import snapshot.json
php bin/console.php import snapshot.json --apply
```

Tanpa `--apply`, tidak ada data yang disimpan. Impor menolak menimpa record/foto
produksi yang sudah ada. Akun administrator yang sudah dibuat dipertahankan.
Password dan sesi lama tidak dipindahkan; reset password akun hasil impor melalui
Super User. Foto snapshot disimpan di MySQL dan referensinya dipetakan ulang.

## Pengujian backend

Gunakan database MySQL terpisah yang kosong, dengan nama berakhiran `_test`.
Set `DB_NAME`, `DB_HOST`, `DB_PORT`, `DB_USER`, dan `DB_PASSWORD` di environment
terminal untuk koneksi pengujian; environment mengalahkan konfigurasi `.env`.

```powershell
$env:DB_NAME = 'newproduksi_test'
php bin/console.php setup
php tests/native.php
```

Tes menolak database yang telah memiliki user/data. Cakupan meliputi password dan
token hash, pembatasan login gagal, transaksi batch, idempotensi, kapasitas SPK,
saldo Press, audit, foto/skor APD, downtime, KPI, hak akses, pencabutan sesi, dan
impor snapshot. Gunakan database tes kosong baru untuk pengulangan.

Uji migrasi menggunakan database `_test` kosong lain: jalankan setup, kemudian
`php tests/split-records.php`. Tes memeriksa pemindahan semua jenis data, rollback
ketika migrasi gagal, kolom yang bisa dibaca langsung, serta keamanan setup ulang.
