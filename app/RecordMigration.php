<?php
namespace App;

use App\Services\Records;

final class RecordMigration
{
    public static function run(): int
    {
        return Database::transaction(function () {
            Database::table('production_locks')->where('id', 1)->lockForUpdate()->first();
            $key = 'split_records_v1';
            if (Database::table('production_migrations')->where('name', $key)->exists()) return 0;
            $exists = Database::run("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'production_records'")->fetchColumn();
            $count = 0;
            if ($exists) {
                $records = new Records();
                foreach (Database::table('production_records')->orderBy('sequence')->get() as $row) {
                    if (!isset(Records::TABLES[$row->kind])) throw new \RuntimeException('Jenis record lama tidak dikenal: '.$row->kind);
                    if ($records->get($row->kind, $row->record_id) !== null) throw new \RuntimeException('Migrasi dibatalkan: ID sudah ada di tabel tujuan.');
                    $records->put($row->kind, $row->record_id, json_decode($row->payload, true, 512, JSON_THROW_ON_ERROR));
                    $count++;
                }
            }
            Database::table('production_migrations')->insert(['name' => $key]);
            return $count;
        });
    }
}
