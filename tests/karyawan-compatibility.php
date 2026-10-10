<?php
// Isolated persistence checks; no connection to the application's database.
namespace App {
    class Database {
        public static string $employeeColumn = 'operator';
        public static array $saved = [];
        public static function run(string $sql, array $bindings): object {
            return new class {
                public function fetchColumn(): int {
                    return Database::$employeeColumn === 'karyawan' ? 1 : 0;
                }
            };
        }
        public static function table(string $table): object {
            return new class {
                public function updateOrInsert(array $key, array $columns): void {
                    Database::$saved = $columns;
                }
            };
        }
    }
}
namespace App\Services {
    class ApdService { public const WEIGHTS = []; }
}
namespace {
    require dirname(__DIR__).'/private/app/Services/Records.php';
    use App\Database;
    use App\Services\Records;
    function expect(bool $condition, string $message): void {
        if (!$condition) throw new \RuntimeException($message);
    }
    foreach (['operator', 'karyawan'] as $column) {
        Database::$employeeColumn = $column;
        $records = new Records();
        foreach (['entry', 'audit', 'apd'] as $kind) {
            $records->put($kind, 'test-id', ['operator' => 'ARIK']);
            expect(Database::$saved[$column] === 'ARIK', "$kind writes $column");
            expect(!array_key_exists($column === 'operator' ? 'karyawan' : 'operator', Database::$saved), 'No nonexistent column written');
            $decode = new \ReflectionMethod(Records::class, 'decode');
            $data = $decode->invoke($records, $kind, (object)Database::$saved);
            expect($data['operator'] === 'ARIK', "$kind reads $column");
        }
    }
    $decode = new \ReflectionMethod(Records::class, 'decode');
    $row = (object)['category'=>'karyawan', 'value'=>'ARIK', 'departemen'=>'Produksi', 'jabatan'=>'Filling'];
    expect($decode->invoke(new Records(), 'master', $row)['category'] === 'operator', 'CSV category mapped to application category');
    foreach ([null, '', '   ', '{}', '[]'] as $extra) {
        $csvRow = (object)['category'=>'produk', 'value'=>'Produk CSV', 'extra'=>$extra];
        expect($decode->invoke(new Records(), 'master', $csvRow)['value'] === 'Produk CSV', 'Empty CSV extra does not prevent reading master');
    }
    foreach (['broken-json', 'null', '123', '"text"'] as $extra) {
        try {
            $decode->invoke(new Records(), 'master', (object)['category'=>'produk', 'value'=>'Produk CSV', 'extra'=>$extra]);
            throw new \RuntimeException('Malformed extra must be rejected');
        } catch (\DomainException $e) {
            expect(str_contains($e->getMessage(), 'production_master'), 'Invalid stored JSON identifies its table');
        }
    }
    $masterId = new \ReflectionMethod(Records::class, 'masterId');
    expect($masterId->invoke(new Records(), $row) === hash('sha256', 'operator|arik'), 'CSV record can be found for edit/delete');
    echo "Karyawan compatibility checks passed.\n";
}
