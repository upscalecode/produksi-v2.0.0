-- Jalankan sekali pada database lama sebelum mengimpor CSV.
-- Tidak menghapus atau menimpa data master yang sudah ada.
ALTER TABLE production_master
  MODIFY record_id VARCHAR(191) NULL DEFAULT NULL,
  MODIFY extra LONGTEXT NULL DEFAULT NULL;
