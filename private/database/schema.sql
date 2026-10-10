CREATE TABLE IF NOT EXISTS production_users (
 username VARCHAR(100) PRIMARY KEY, name VARCHAR(255) NOT NULL,
 password VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'user',
 active BOOLEAN NOT NULL DEFAULT TRUE, permissions JSON NOT NULL, created_at TIMESTAMP NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS production_tokens (
 hash VARCHAR(64) PRIMARY KEY, username VARCHAR(100) NOT NULL,
 expires_at TIMESTAMP NOT NULL, INDEX (expires_at),
 FOREIGN KEY (username) REFERENCES production_users(username) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS production_locks (id INT UNSIGNED PRIMARY KEY) ENGINE=InnoDB;
INSERT IGNORE INTO production_locks (id) VALUES (1);
CREATE TABLE IF NOT EXISTS production_photos (
 id CHAR(36) PRIMARY KEY, owner VARCHAR(100) NOT NULL, mime VARCHAR(30) NOT NULL,
 content LONGTEXT NOT NULL, created_at TIMESTAMP NOT NULL, INDEX (owner)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS production_login_attempts (
 id VARCHAR(100) PRIMARY KEY, attempts INT UNSIGNED NOT NULL, expires_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_migrations (name VARCHAR(100) PRIMARY KEY) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `production_master` (
 sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 record_id VARCHAR(191) NULL DEFAULT NULL UNIQUE,
 `category` TEXT NULL,
 `value` TEXT NULL,
 `departemen` VARCHAR(100) NULL,
 `jabatan` VARCHAR(100) NULL,
 extra LONGTEXT NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `production_entries` (
 sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 record_id VARCHAR(191) NOT NULL UNIQUE,
 `id` TEXT NULL,
 `reportId` TEXT NULL,
 `tab` TEXT NULL,
 `tanggal` TEXT NULL,
 `karyawan` TEXT NULL,
 `produk` TEXT NULL,
 `botol` TEXT NULL,
 `botolPecahJenis` TEXT NULL,
 `qtyKardus` DOUBLE NULL,
 `qtyBotolPerKardus` DOUBLE NULL,
 `totalQty` DOUBLE NULL,
 `qtyBotolPecah` DOUBLE NULL,
 `qtyKardusBasah` DOUBLE NULL,
 `createdBy` TEXT NULL,
 `createdAt` TEXT NULL,
 `updatedAt` TEXT NULL,
 `updateCount` BIGINT NULL,
 `sisaPressTanggalAsal` TEXT NULL,
 `keterangan` TEXT NULL,
 extra JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `production_spk` (
 sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 record_id VARCHAR(191) NOT NULL UNIQUE,
 `batchNo` TEXT NULL,
 `tanggal` TEXT NULL,
 `produk` TEXT NULL,
 `botol` TEXT NULL,
 `produksiDus` BIGINT NULL,
 `qtyPerDus` BIGINT NULL,
 `qty` DOUBLE NULL,
 `createdBy` TEXT NULL,
 `createdAt` TEXT NULL,
 `updatedAt` TEXT NULL,
 `updateCount` BIGINT NULL,
 `status` TEXT NULL,
 extra JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `production_apd` (
 sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 record_id VARCHAR(191) NOT NULL UNIQUE,
 `id` TEXT NULL,
 `tanggal` TEXT NULL,
 `karyawan` TEXT NULL,
 `totalPoints` DOUBLE NULL,
 `percentage` DOUBLE NULL,
 `alasan` TEXT NULL,
 `photoFileIds` JSON NULL,
 `photoFileId` TEXT NULL,
 `createdBy` TEXT NULL,
 `createdAt` TEXT NULL,
 `updatedAt` TEXT NULL,
 `maskerTidakSesuai` BIGINT NULL,
 `lenganDitarik` BIGINT NULL,
 `sepatuDiinjak` BIGINT NULL,
 `rambutKelihatan` BIGINT NULL,
 `resletingTidakPenuh` BIGINT NULL,
 `memakaiAksesoris` BIGINT NULL,
 `kebersihanSepatu` BIGINT NULL,
 extra JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `production_press_adjustments` (
 sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 record_id VARCHAR(191) NOT NULL UNIQUE,
 `id` TEXT NULL,
 `tanggal` TEXT NULL,
 `produk` TEXT NULL,
 `botol` TEXT NULL,
 `qtyDitutup` DOUBLE NULL,
 `qtyBotolPerKardus` DOUBLE NULL,
 `targetBatchNo` TEXT NULL,
 `targetTanggalAsal` TEXT NULL,
 `alasan` TEXT NULL,
 `closedBy` TEXT NULL,
 `closedByName` TEXT NULL,
 `createdAt` TEXT NULL,
 extra JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `production_entry_audits` (
 sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 record_id VARCHAR(191) NOT NULL UNIQUE,
 `id` TEXT NULL,
 `reportId` TEXT NULL,
 `tab` TEXT NULL,
 `tanggal` TEXT NULL,
 `karyawan` TEXT NULL,
 `produk` TEXT NULL,
 `botol` TEXT NULL,
 `botolPecahJenis` TEXT NULL,
 `qtyKardus` DOUBLE NULL,
 `qtyBotolPerKardus` DOUBLE NULL,
 `totalQty` DOUBLE NULL,
 `qtyBotolPecah` DOUBLE NULL,
 `qtyKardusBasah` DOUBLE NULL,
 `createdBy` TEXT NULL,
 `createdAt` TEXT NULL,
 `updatedAt` TEXT NULL,
 `updateCount` BIGINT NULL,
 `sisaPressTanggalAsal` TEXT NULL,
 `keterangan` TEXT NULL,
 `batchNo` TEXT NULL,
 `key` TEXT NULL,
 `nextUpdateCount` BIGINT NULL,
 `deletedBy` TEXT NULL,
 `deletedAt` TEXT NULL,
 `restoredEntryId` TEXT NULL,
 `restoredAt` TEXT NULL,
 `line` TEXT NULL,
 extra JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `production_downtime` (
 sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 record_id VARCHAR(191) NOT NULL UNIQUE,
 `productionStartTime` TEXT NULL,
 `timestamp` TEXT NULL,
 `tanggal` TEXT NULL,
 `downTime` BIGINT NULL,
 `alasan` TEXT NULL,
 `keterangan` TEXT NULL,
 extra JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `production_settings` (
 sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 record_id VARCHAR(191) NOT NULL UNIQUE,
 `kpiFillingOutputTargetMonthly` BIGINT NULL,
 `kpiPressOutputTargetMonthly` BIGINT NULL,
 extra JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
