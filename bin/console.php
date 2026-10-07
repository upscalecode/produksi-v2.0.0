<?php
require dirname(__DIR__).'/bootstrap.php';
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
use App\Database as DB;
use App\Services\Accounts;
use App\Services\Records;
try {
    switch ($argv[1] ?? 'help') {
        case 'doctor':
            foreach (['pdo_mysql', 'mbstring', 'iconv'] as $extension) {
                if (!extension_loaded($extension)) throw new DomainException("Ekstensi PHP $extension belum aktif.");
            }
            echo "Ekstensi PHP tersedia.\n";
            try {
                DB::run('SELECT 1');
            } catch (PDOException $e) {
                $code = (int) ($e->errorInfo[1] ?? 0);
                throw new DomainException(match ($code) {
                    1044, 1045 => 'Akses MySQL ditolak. Periksa user, password, dan izin database di koneksi.php atau DB_* di .env.',
                    1049 => 'Database tidak ditemukan. Periksa nama database di koneksi.php atau DB_NAME di .env.',
                    2002, 2003, 2005 => 'Koneksi MySQL gagal. Periksa host, port, dan status server database.',
                    default => "Pemeriksaan koneksi MySQL gagal (kode $code). Periksa log PHP hosting.",
                });
            }
            echo "Koneksi MySQL berhasil.\n";
            $required = ['production_locks', 'production_users', 'production_tokens', 'production_login_attempts'];
            $tables = DB::run('SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()')->fetchAll(PDO::FETCH_COLUMN);
            $missing = array_diff($required, $tables);
            if ($missing) throw new DomainException('Tabel login belum lengkap: '.implode(', ', $missing).'. Jalankan php bin/console.php setup.');
            if (!DB::table('production_locks')->where('id', 1)->exists()) throw new DomainException('Baris pengunci belum tersedia. Jalankan php bin/console.php setup.');
            echo "Tabel login tersedia.\n";
            if (!DB::table('production_users')->where('active', true)->exists()) throw new DomainException('Belum ada akun aktif. Isi ADMIN_PASSWORD minimal 12 karakter lalu jalankan php bin/console.php admin.');
            echo "Akun aktif tersedia. Jika login ditolak, periksa username/password dan pesan API login.\n";
            break;
        case 'setup':
            foreach (explode(';', file_get_contents(dirname(__DIR__).'/database/schema.sql')) as $sql) {
                if (trim($sql) !== '') DB::connection()->exec($sql);
            }
            $migrated = App\RecordMigration::run();
            echo "Migrasi tabel terpisah: $migrated record.\n";
            if (DB::run("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'master_values'")->fetchColumn()) {
                DB::transaction(function () {
                    DB::table('production_locks')->where('id', 1)->lockForUpdate()->first();
                    $records = new Records();
                    foreach (DB::run("SELECT category, value FROM master_values WHERE category IN ('operator','produk','botol') ORDER BY position")->fetchAll() as $row) {
                        $value = trim($row->value);
                        $id = hash('sha256', $row->category.'|'.mb_strtolower($value));
                        if ($value !== '' && !$records->get('master', $id)) $records->put('master', $id, ['category' => $row->category, 'value' => $value]);
                    }
                });
            }
            echo "Tabel MySQL siap. Data yang sudah ada dipertahankan.\n"; break;
        case 'admin':
            $username = $argv[2] ?? (getenv('ADMIN_USERNAME') ?: 'admin');
            $password = getenv('ADMIN_PASSWORD') ?: '';
            if (strlen($password) < 12) throw new DomainException('Isi ADMIN_PASSWORD minimal 12 karakter di .env atau environment.');
            DB::transaction(function () use ($username, $password) {
                DB::table('production_locks')->where('id', 1)->lockForUpdate()->first();
                (new Accounts())->add(['username' => $username, 'name' => 'Administrator', 'password' => $password, 'role' => 'superuser']);
            });
            echo "Administrator dibuat. Hapus ADMIN_PASSWORD dari .env setelah selesai.\n"; break;
        case 'reset-password':
            $username = mb_strtolower(trim($argv[2] ?? ''));
            if ($username === '') throw new DomainException('Tentukan username: php bin/console.php reset-password [username].');
            $password = getenv('USER_PASSWORD') ?: '';
            if (strlen($password) < 12 || strlen($password) > 255) throw new DomainException('Isi USER_PASSWORD sepanjang 12–255 karakter di .env atau environment.');
            DB::transaction(function () use ($username, $password) {
                $row = DB::table('production_users')->where('username', $username)->lockForUpdate()->first();
                if (!$row) throw new DomainException('User tidak ditemukan. Gunakan perintah admin untuk membuat administrator baru.');
                if (!$row->active) throw new DomainException('Akun tidak aktif. Aktifkan akun melalui administrator sebelum reset password.');
                DB::table('production_users')->where('username', $username)->update(['password' => password_hash($password, PASSWORD_DEFAULT)]);
                DB::table('production_tokens')->where('username', $username)->delete();
                DB::table('production_login_attempts')->where('id', 'production-login:'.hash('sha256', $username))->delete();
            });
            echo "Password diperbarui dan sesi lama dicabut. Hapus USER_PASSWORD dari .env setelah selesai.\n"; break;
        case 'import':
            exit((new App\ImportProduction())->run($argv[2] ?? '', in_array('--apply', $argv, true), new Records()));
        default:
            echo "php bin/console.php doctor\nphp bin/console.php setup\nphp bin/console.php admin [username]\nphp bin/console.php reset-password [username]\nphp bin/console.php import snapshot.json [--apply]\n";
    }
} catch (Throwable $e) { fwrite(STDERR, $e->getMessage()."\n"); exit(1); }
