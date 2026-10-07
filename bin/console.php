<?php
require dirname(__DIR__).'/bootstrap.php';
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
use App\Database as DB;
use App\Services\Accounts;
use App\Services\Records;
try {
    switch ($argv[1] ?? 'help') {
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
        case 'import':
            exit((new App\ImportProduction())->run($argv[2] ?? '', in_array('--apply', $argv, true), new Records()));
        default:
            echo "php bin/console.php setup\nphp bin/console.php admin [username]\nphp bin/console.php import snapshot.json [--apply]\n";
    }
} catch (Throwable $e) { fwrite(STDERR, $e->getMessage()."\n"); exit(1); }
