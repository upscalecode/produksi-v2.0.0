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
2. Jalankan `php private/bin/console.php setup` untuk membuat tabel. Perintah ini tidak
   menghapus data yang sudah ada. Jika tabel lama `master_values` tersedia,
   master diimpor tanpa menimpa nilai yang sudah ada.
3. Isi `ADMIN_PASSWORD` di `.env` dengan password minimal 12 karakter, kemudian
   jalankan `php private/bin/console.php admin`. Akun yang sudah ada tidak ditimpa.
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

## Deploy GitHub melalui Git hPanel (alur utama)

Repository siap di-deploy langsung ke public_html. Pilih repository dan branch
aktif di hPanel; Install Path kosong menggunakan public_html. Commit dan push
perubahan struktur ini, lalu deploy branch tersebut. Folder deployment/ bukan
bagian dari alur Git hPanel; paket pada bagian berikut hanya untuk unggah manual.

Struktur hasil checkout:

```text
folder domain/
??? .env                     (konfigurasi hosting yang sudah ada)
??? public_html/
    ??? .htaccess            (pengarah URL dan penolakan akses backend)
    ??? private/
    ?   ??? .htaccess        (Require all denied)
    ?   ??? app/
    ?   ??? bin/
    ?   ??? database/
    ?   ??? bootstrap.php
    ?   ??? koneksi.php
    ??? public/
        ??? .htaccess
        ??? index.php
        ??? halaman dan aset
```

URL pengguna tetap /login.html dan /api/production; tidak perlu menambahkan
/public/ di URL. Akses HTTP ke private/, tests/, tools/, database/, dan storage/
ditolak oleh .htaccess root. private/.htaccess juga menolak akses langsung.
Server wajib menerapkan aturan .htaccess; verifikasi /private/bootstrap.php
dan /private/database/schema.sql menghasilkan 403 tanpa isi file setelah deploy.

Backend dipindahkan ke private/ tanpa mengubah database. Loader mencari .env
berurutan di private/, root repository, lalu induk repository. Jadi .env yang
sudah sejajar dengan public_html tetap terbaca. Pertahankan konfigurasi hosting
tersebut dan jangan masukkan rahasia ke GitHub. koneksi.php sekarang ada di
private/koneksi.php; sesuaikan jika sebelumnya mengubahnya langsung di hosting.

Tes PHP dapat dijalankan dari root repository seperti sebelumnya. Perintah CLI
sekarang memakai php private/bin/console.php. Pemisahan backend ke luar
public_html memerlukan alur deployment tambahan; bukan dilakukan otomatis oleh
checkout Git hPanel ini.

## Paket alternatif untuk unggah manual

Buat paket dari root proyek:

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-hosting.ps1 -Layout outside
```

Paket tersedia di `deployment/outside/` (diabaikan Git). Unggah isi
`public_html/` paket ke `public_html/` hosting, termasuk `.htaccess`.
Unggah folder `private/` sejajar dengan `public_html/`:

```text
folder domain/
??? .env
??? private/
?   ??? .htaccess
?   ??? app/
?   ??? bin/
?   ??? database/
?   ??? bootstrap.php
?   ??? koneksi.php
??? public_html/
    ??? .htaccess
    ??? index.php
    ??? login.html
    ??? aset dan halaman lainnya
```

File penanda DO_NOT_UPLOAD_HERE saja belum membuktikan bahwa folder tersebut
bisa atau tidak bisa dipakai. Pastikan melalui panel hosting bahwa folder
`private/` dapat dibuat dan dibaca PHP (termasuk batas `open_basedir`).
Paket tidak menyalin .env. Pertahankan .env hosting di lokasi pada diagram,
atau simpan di private/.env. Periksa koneksi.php sebelum unggah; jangan
menimpa konfigurasi hosting dengan kredensial lokal.

Jika backend di luar public_html tidak diizinkan, buat paket cadangan:

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-hosting.ps1 -Layout inside
```

Unggah isi `deployment/inside/public_html/` ke `public_html/` hosting.
Backend berada di `public_html/private/`; simpan .env di
`public_html/private/.env`. .htaccess publik menolak URL /private/ dan
private/.htaccess berisi Require all denied. Perlindungan ini memerlukan
server yang menerapkan .htaccess (Apache/LiteSpeed); jangan gunakan paket
cadangan pada server yang mengabaikannya. Jangan meninggalkan dua salinan
backend: loader memprioritaskan private/ di luar public_html.

Setelah unggah, /login.html harus terbuka, /api/production?action=ping
harus mengembalikan JSON, dan /private/bootstrap.php serta
/private/database/schema.sql harus ditolak (403/404), tanpa isi file.
Respons 503 Backend belum tersedia menunjukkan lokasi/izin backend salah.
Dari root repository, gunakan `php private/bin/console.php doctor` untuk
memeriksa database dan `php private/bin/console.php env` untuk lokasi konfigurasi.

Jangan unggah .git/, .runtime/, tes, dump data karyawan, atau seluruh root
repository ke folder publik. Paket hanya menyertakan backend dan skema/migrasi
yang diperlukan. Paket memuat koneksi.php sehingga tetap bersifat privat.
Builder tidak menimpa paket yang sudah ada; pindahkan paket lama sebelum
membuat ulang. Struktur pengembangan lokal tetap memakai public/.

## Struktur

Jika login gagal, jalankan `php private/bin/console.php doctor` melalui terminal pada
server tempat aplikasi berjalan. Perintah ini hanya membaca: memeriksa ekstensi
PHP, koneksi MySQL, tabel login, baris pengunci, dan keberadaan akun aktif.
Konfigurasi bawaan lokal belum tentu cocok dengan akun database hosting.
Nilai `DB_*` di environment atau `.env` mengalahkan `koneksi.php`.
Jika tabel belum lengkap, jalankan `php private/bin/console.php setup`. Jika belum ada
akun aktif, isi `ADMIN_PASSWORD` lalu jalankan `php private/bin/console.php admin`,
kemudian hapus `ADMIN_PASSWORD`. Jangan mengirim password atau isi konfigurasi
database saat membagikan hasil pemeriksaan.

- `public/`: delapan halaman HTML, CSS, JavaScript, gambar, dan endpoint PHP.
- `private/app/Services/`: login, hak akses, SPK, Filling, Press, APD, dan saldo produksi.
- `private/app/Database.php`: koneksi PDO dan kueri dengan parameter terikat.
- `private/app/Http/Controllers/ProductionController.php`: pemetaan action API.
- `bootstrap.php`: pemuatan konfigurasi dan kelas aplikasi tanpa dependency.
- `private/database/schema.sql`: skema MySQL.
- `private/bin/console.php`: setup, pembuatan administrator, dan impor snapshot.

File tampilan aktif hanya berada di `public/`. Salinan frontend di root, backend
Google Apps Script lama, dan arsip framework Laravel telah dihapus.
`tools/split-pages.ps1` membaca dan memperbarui halaman di `public/`.
`tools/export-php.gs` tetap tersedia untuk ekspor dari proyek Apps Script lama
yang masih memiliki backend aslinya.

## Tabel seperti spreadsheet

### Departemen dan jabatan operator

Master operator sekarang memiliki kolom `departemen` dan `jabatan` pada tabel
`production_master`. Untuk database lama jalankan `php private/bin/console.php setup`;
perintah ini dapat diulang dan mempertahankan data. Jika hosting tidak memiliki
terminal, jalankan `private/database/operator-department-migration.sql` sekali melalui
phpMyAdmin sebelum mengunggah kode aplikasi terbaru.

Di **Setting → Data Master → Operator**, isi Departemen `Produksi` dan
Jabatan / Bagian `Operator Filling` atau `Operator Press`. Klik **Edit** pada nama operator lama
untuk melengkapi atau mengubah pembagiannya. Departemen `Filling` atau `Press`
juga didukung dengan jabatan bebas, misalnya `Operator`.

Pilihan operator pada form serta filter laporan/KPI mengikuti bagian yang dipilih.
Server menolak penyimpanan operator ke bagian yang berbeda, termasuk permintaan
batch. Operator dari departemen lain atau yang belum memiliki bagian produksi
tidak muncul pada pilihan produksi. APD produksi menampilkan kedua bagian.
Riwayat tersimpan tidak dihapus atau dipindahkan saat metadata operator diubah.

Data lama tidak diberi departemen/jabatan secara otomatis karena pembagian nama
belum diketahui. Lengkapi operator sebelum membuat pengerjaan baru. Ekspor master
CSV dan impor snapshot JSON mempertahankan departemen serta jabatan. Snapshot
lama tetap dapat diimpor, lalu operator dilengkapi melalui menu Master.

Untuk CSV operator di phpMyAdmin, gunakan daftar kolom
`category,value,departemen,jabatan` dan lewati header. Contoh tersedia pada
`private/database/operator-template.csv`. Kolom `extra` kosong otomatis dibaca sebagai
objek kosong, sehingga impor juga kompatibel dengan MySQL lokal yang tidak
mendukung nilai bawaan pada kolom `LONGTEXT`.

Jika Laporan Hasil Pengerjaan dan KPI tampil di lokal tetapi kosong di hosting,
unggah `private/app/Http/Controllers/ProductionController.php`, `public/script.js`, dan
halaman HTML di `public/` dari versi yang sama. Pertahankan `koneksi.php` dan
`.env` hosting. API menyediakan `reportEntries` lengkap untuk akun berhak akses
laporan, termasuk ketika dashboard memakai data yang sama, agar JavaScript lama
tetap dapat membaca laporan. Halaman HTML memakai versi URL JavaScript terbaru
untuk memperbarui cache browser. Jika ada cache CDN/hosting, bersihkan cache
halaman HTML dan JavaScript setelah unggahan.

Periksa apakah tabel Filling/Press di hosting berisi data tersimpan serta apakah
bulan laporan sesuai tanggal data. Jika tabel tersebut juga kosong, periksa
database yang dipakai hosting dan proses impor/migrasi; data lokal tidak otomatis
tersalin ke hosting. Jangan membagikan token sesi atau isi konfigurasi database.

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
`php private/bin/console.php setup` sebelum menjalankan kode baru. Setup menyalin isi
`production_records` ke tabel tujuan dalam satu transaksi, mempertahankan urutan
record, dan menandai migrasi selesai di `production_migrations`. Data lama tidak
dihapus, tetapi tabel tersebut tidak lagi dibaca/ditulis aplikasi. Jangan gunakan
kode versi lama setelah migrasi. Menjalankan setup ulang tidak menyalin ulang data.
Jika jenis record tidak dikenal atau ID tujuan bertabrakan, migrasi dibatalkan
tanpa menimpa data; tabel tujuan yang baru dibuat tetap tersedia untuk pemeriksaan.

## Impor snapshot spreadsheet

### Impor master dari CSV (phpMyAdmin)

CSV master hanya membutuhkan `category,value`; kategori yang digunakan adalah
`operator`, `produk`, dan `botol`. Contoh tersedia di `private/database/master-template.csv`.
Kategori `karyawan` juga diterima sebagai alias `operator`, termasuk untuk edit
dan hapus melalui aplikasi. Contoh: `karyawan,ARIK,Produksi,Operator Filling` dengan
header dan daftar kolom impor `category,value,departemen,jabatan`.
Kolom laporan `karyawan` pada schema baru didukung; tabel lama dengan kolom
`operator` tetap dapat digunakan. Mengedit `schema.sql` tidak mengubah tabel
yang sudah ada karena setup menggunakan `CREATE TABLE IF NOT EXISTS`.
Gunakan nilai tidak kosong, maksimal 200 karakter, tanpa duplikat kategori/nama.
Kolom `sequence` otomatis, `record_id` boleh kosong (NULL), dan `extra` kosong
dibaca sebagai `{}`. Untuk operator sertakan departemen serta jabatan seperti
contoh `private/database/operator-template.csv`, atau lengkapi melalui menu Master.

Untuk database lama, unggah kode aplikasi terbaru dan jalankan
`private/database/master-csv-migration.sql` melalui tab SQL phpMyAdmin sebelum impor.
Migrasi ini mempertahankan semua data lama. Untuk database baru gunakan setup biasa.

Pilih tabel `production_master`, buka **Import**, pilih format **CSV**, separator
koma, enclosure tanda kutip ganda, charset UTF-8, dan isi daftar kolom
`category,value`. Lewati baris pertama (header); jika opsi tersebut tidak tersedia,
hapus header dari salinan CSV sebelum impor. Jangan sertakan kolom teknis dalam CSV.
Jika Excel menghasilkan separator titik koma, pilih separator `;` saat impor.
Impor CSV langsung tidak memvalidasi kategori atau mencegah duplikat nama;
periksa isi CSV dahulu. Data hasil impor dapat digunakan dan dihapus lewat aplikasi.

Gunakan `tools/export-php.gs` di proyek Apps Script lama untuk menghasilkan
snapshot JSON. Validasi dahulu, kemudian terapkan ke database produksi kosong:

```powershell
php private/bin/console.php import snapshot.json
php private/bin/console.php import snapshot.json --apply
```

Tanpa `--apply`, tidak ada data yang disimpan. Impor menolak menimpa record/foto
produksi yang sudah ada. Akun administrator yang sudah dibuat dipertahankan.
Password dan sesi lama tidak dipindahkan; reset password akun hasil impor melalui
Super User. Foto snapshot disimpan di MySQL dan referensinya dipetakan ulang.

## Login ditolak di hosting

Password MySQL pada `koneksi.php` digunakan untuk koneksi database, bukan untuk
login aplikasi. Pesan `Username atau password salah.` berarti akun tidak
ditemukan, tidak aktif, atau password tidak cocok. Password akun hasil impor
tidak dipindahkan dari aplikasi lama.

Dari terminal hosting, di root proyek, jalankan `php private/bin/console.php doctor`
untuk memeriksa koneksi dan tabel. Untuk akun aktif yang sudah ada, isi sementara
`USER_PASSWORD` di `.env` dengan password baru sepanjang 12–255 karakter, lalu:

```sh
php private/bin/console.php reset-password admin
```

Ganti `admin` dengan username akun. Perintah ini mencabut sesi lama dan menghapus
batas percobaan login akun tersebut. Hapus `USER_PASSWORD` dari `.env` setelah
selesai, lalu login dengan password baru. Akun tidak aktif tidak diaktifkan oleh
perintah ini. Jika akun belum ada, gunakan perintah `admin` dengan
`ADMIN_PASSWORD` sesuai petunjuk instalasi.

## Pengujian backend

Konfigurasi database hosting dapat diisi pada `koneksi.php` di root proyek:
ubah `host`, `port`, `name`, `user`, dan `password` sesuai akun database hosting.
`private/app/Database.php` membaca file ini otomatis. Nilai `DB_*` dari environment
atau `.env` tetap diprioritaskan, termasuk password environment yang kosong.
Simpan `koneksi.php` di luar folder `public/` dan jangan commit password asli.

Gunakan database MySQL terpisah yang kosong, dengan nama berakhiran `_test`.
Set `DB_NAME`, `DB_HOST`, `DB_PORT`, `DB_USER`, dan `DB_PASSWORD` di environment
terminal untuk koneksi pengujian; environment mengalahkan konfigurasi `.env`.

```powershell
$env:DB_NAME = 'newproduksi_test'
php private/bin/console.php setup
php tests/native.php
```

Tes menolak database yang telah memiliki user/data. Cakupan meliputi password dan
token hash, pembatasan login gagal, transaksi batch, idempotensi, kapasitas SPK,
saldo Press, audit, foto/skor APD, downtime, KPI, hak akses, pencabutan sesi, dan
impor snapshot. Gunakan database tes kosong baru untuk pengulangan.

Uji migrasi menggunakan database `_test` kosong lain: jalankan setup, kemudian
`php tests/split-records.php`. Tes memeriksa pemindahan semua jenis data, rollback
ketika migrasi gagal, kolom yang bisa dibaca langsung, serta keamanan setup ulang.
