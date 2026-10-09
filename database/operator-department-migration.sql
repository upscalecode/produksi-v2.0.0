-- Jalankan sekali melalui phpMyAdmin pada database lama.
-- Alternatif yang bisa dijalankan ulang: php bin/console.php setup.
-- Data lama dipertahankan. Lengkapi operator melalui menu Master / Edit.
ALTER TABLE production_master
  ADD COLUMN departemen VARCHAR(100) NULL,
  ADD COLUMN jabatan VARCHAR(100) NULL,
  MODIFY extra LONGTEXT NULL DEFAULT NULL;
