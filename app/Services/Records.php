<?php
namespace App\Services;
use App\Database as DB;

/** Spreadsheet collections stored in separate tables with readable columns. */
class Records
{
    public const TABLES = [
        'master' => 'production_master', 'entry' => 'production_entries',
        'spk' => 'production_spk', 'apd' => 'production_apd',
        'adjustment' => 'production_press_adjustments', 'audit' => 'production_entry_audits',
        'downtime' => 'production_downtime', 'settings' => 'production_settings',
    ];

    public static function fields(string $kind): array
    {
        $entry = ['id','reportId','tab','tanggal','operator','produk','botol','botolPecahJenis',
            'qtyKardus:f','qtyBotolPerKardus:f','totalQty:f','qtyBotolPecah:f','qtyKardusBasah:f',
            'createdBy','createdAt','updatedAt','updateCount:i','sisaPressTanggalAsal','keterangan'];
        $fields = match ($kind) {
            'master' => ['category','value'],
            'entry' => $entry,
            'audit' => [...$entry,'batchNo','key','nextUpdateCount:i','deletedBy','deletedAt','restoredEntryId','restoredAt','line'],
            'spk' => ['batchNo','tanggal','produk','botol','produksiDus:i','qtyPerDus:i','qty:f','createdBy','createdAt','updatedAt','updateCount:i','status'],
            'adjustment' => ['id','tanggal','produk','botol','qtyDitutup:f','qtyBotolPerKardus:f','targetBatchNo','targetTanggalAsal','alasan','closedBy','closedByName','createdAt'],
            'downtime' => ['productionStartTime','timestamp','tanggal','downTime:i','alasan','keterangan'],
            'settings' => ['kpiFillingOutputTargetMonthly:i','kpiPressOutputTargetMonthly:i'],
            'apd' => ['id','tanggal','operator','totalPoints:f','percentage:f','alasan','photoFileIds:j','photoFileId','createdBy','createdAt','updatedAt',
                ...array_map(fn($key) => $key.':i', array_keys(ApdService::WEIGHTS))],
            default => throw new \InvalidArgumentException('Jenis record tidak dikenal: '.$kind),
        };
        $result = [];
        foreach ($fields as $field) {
            [$name, $type] = array_pad(explode(':', $field), 2, 's');
            $result[$name] = $type;
        }
        return $result;
    }

    private function table(string $kind): string
    {
        return self::TABLES[$kind] ?? throw new \InvalidArgumentException('Jenis record tidak dikenal: '.$kind);
    }

    private function decode(string $kind, object $row): array
    {
        $data = json_decode($row->extra, true, 512, JSON_THROW_ON_ERROR);
        foreach (self::fields($kind) as $name => $type) {
            if ($row->$name === null) continue;
            $value = match ($type) {
                'i' => (int) $row->$name, 'f' => (float) $row->$name,
                'j' => json_decode($row->$name, true, 512, JSON_THROW_ON_ERROR),
                default => $row->$name,
            };
            if ($kind === 'apd' && array_key_exists($name, ApdService::WEIGHTS)) $data['scores'][$name] = $value;
            else $data[$name] = $value;
        }
        return $data;
    }

    public function all(string $kind): array
    {
        return array_map(fn($row) => $this->decode($kind, $row), DB::table($this->table($kind))->orderBy('sequence')->get());
    }

    public function get(string $kind, string $id): ?array
    {
        if ($kind === 'master') {
            $row = $this->masterRow($id);
            return $row ? $this->decode($kind, $row) : null;
        }
        $row = DB::table($this->table($kind))->where('record_id', $id)->first();
        return $row ? $this->decode($kind, $row) : null;
    }

    public function put(string $kind, string $id, array $data): array
    {
        if ($kind === 'master') {
            $row = $this->masterRow($id);
            $columns = ['category' => $data['category'], 'value' => trim($data['value'])];
            if ($row) DB::table('production_master')->where('sequence', $row->sequence)->update($columns);
            else DB::table('production_master')->insert($columns + ['record_id' => $id, 'extra' => '{}']);
            return $data;
        }
        $flat = $data;
        if ($kind === 'apd') {
            $flat = array_merge($data, $data['scores'] ?? []);
            unset($flat['scores']);
        }
        $columns = [];
        foreach (self::fields($kind) as $name => $type) {
            $value = $flat[$name] ?? null;
            $columns[$name] = $value !== null && $type === 'j' ? json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) : $value;
            if ($value !== null) unset($flat[$name]);
        }
        $columns['extra'] = json_encode($flat, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        DB::table($this->table($kind))->updateOrInsert(['record_id' => $id], $columns);
        return $data;
    }

    public function delete(string $kind, string $id): void
    {
        if ($kind === 'master') {
            foreach (DB::table('production_master')->get() as $row) {
                if ($this->masterId($row) === $id || $row->record_id === $id) {
                    DB::table('production_master')->where('sequence', $row->sequence)->delete();
                }
            }
            return;
        }
        DB::table($this->table($kind))->where('record_id', $id)->delete();
    }

    public function clear(string $kind): int { return DB::table($this->table($kind))->delete(); }

    private function masterId(object $row): string
    {
        return hash('sha256', $row->category.'|'.mb_strtolower(trim((string) $row->value)));
    }

    private function masterRow(string $id): ?object
    {
        foreach (DB::table('production_master')->orderBy('sequence')->get() as $row) {
            if ($this->masterId($row) === $id || $row->record_id === $id) return $row;
        }
        return null;
    }

    public function exists(): bool
    {
        foreach (self::TABLES as $table) if (DB::table($table)->exists()) return true;
        return false;
    }
}
