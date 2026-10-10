<?php
namespace App\Services;
use App\Database as DB;

/** Spreadsheet collections stored in separate tables with readable columns. */
class Records
{
    private array $employeeColumns = [];

    public static function masterCategory(string $category): string
    {
        return $category === 'karyawan' ? 'operator' : $category;
    }

    private function employeeColumn(string $kind): string
    {
        return $this->employeeColumns[$kind] ??= DB::run(
            'SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',
            [$this->table($kind), 'karyawan']
        )->fetchColumn() ? 'karyawan' : 'operator';
    }
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
            'master' => ['category','value','departemen','jabatan'],
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
        $extra = trim((string) ($row->extra ?? ''));
        try {
            $data = $extra === '' ? [] : json_decode($extra, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            error_log('Invalid extra JSON in '.$this->table($kind).' sequence '.($row->sequence ?? '?').': '.$e->getMessage());
            throw new \DomainException('Data tambahan JSON pada tabel '.$this->table($kind).' baris '.($row->sequence ?? '?').' tidak valid. Periksa kolom extra pada database.');
        }
        if (!is_array($data)) {
            throw new \DomainException('Kolom extra pada tabel '.$this->table($kind).' harus berupa objek atau daftar JSON.');
        }
        foreach (self::fields($kind) as $name => $type) {
            $column = $name === 'operator' ? $this->employeeColumn($kind) : $name;
            if (($row->$column ?? null) === null) continue;
            $value = match ($type) {
                'i' => (int) $row->$column, 'f' => (float) $row->$column,
                'j' => json_decode($row->$column, true, 512, JSON_THROW_ON_ERROR),
                default => $row->$column,
            };
            if ($kind === 'apd' && array_key_exists($name, ApdService::WEIGHTS)) $data['scores'][$name] = $value;
            else $data[$name] = $value;
        }
        if ($kind === 'master') $data['category'] = self::masterCategory($data['category']);
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
            foreach (['departemen', 'jabatan'] as $field) {
                if (array_key_exists($field, $data)) $columns[$field] = trim((string) $data[$field]);
            }
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
            $column = $name === 'operator' ? $this->employeeColumn($kind) : $name;
            $columns[$column] = $value !== null && $type === 'j' ? json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) : $value;
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
        return hash('sha256', self::masterCategory($row->category).'|'.mb_strtolower(trim((string) $row->value)));
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
