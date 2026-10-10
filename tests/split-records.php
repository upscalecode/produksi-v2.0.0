<?php
require dirname(__DIR__).'/private/bootstrap.php';
use App\Database as DB;
use App\Services\Records;
use App\RecordMigration;

if (!preg_match('/_test$/', getenv('DB_NAME') ?: '')) throw new RuntimeException('Gunakan database _test kosong.');
$records = new Records();
if ($records->exists() || DB::table('production_users')->exists() || DB::table('production_photos')->exists()) throw new RuntimeException('Gunakan database test kosong.');
DB::connection()->exec('CREATE TABLE production_records (sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, kind VARCHAR(30) NOT NULL, record_id VARCHAR(191) NOT NULL, payload JSON NOT NULL, UNIQUE KEY (kind, record_id)) ENGINE=InnoDB');
DB::table('production_migrations')->where('name', 'split_records_v1')->delete();
$fixtures = [
    'entry' => ['id'=>'entry-1','tab'=>'filling','tanggal'=>'2026-10-07','operator'=>'Operator A','qtyKardus'=>2.5,'totalQty'=>30,'updateCount'=>0,'updatedAt'=>'','futureField'=>['retained'=>true]],
    'spk' => ['batchNo'=>'01-07102026','produksiDus'=>3,'qtyPerDus'=>12,'qty'=>36],
    'master' => ['category'=>'produk','value'=>'Produk A'],
    'apd' => ['id'=>'apd-1','scores'=>array_fill_keys(array_keys(App\Services\ApdService::WEIGHTS), 0),'photoFileIds'=>[],'percentage'=>0],
    'audit' => ['id'=>'audit-1','key'=>'filling|2026-10-07|batch','nextUpdateCount'=>2],
    'adjustment' => ['id'=>'adjustment-1','qtyDitutup'=>1.25],
    'downtime' => ['tanggal'=>'2026-10-07','downTime'=>-10],
    'settings' => ['kpiFillingOutputTargetMonthly'=>150000,'kpiPressOutputTargetMonthly'=>70000],
];
foreach ($fixtures as $kind=>$data) DB::table('production_records')->insert(['kind'=>$kind,'record_id'=>$kind,'payload'=>json_encode($data)]);
DB::table('production_records')->insert(['kind'=>'unknown','record_id'=>'bad','payload'=>'{}']);
try { RecordMigration::run(); throw new LogicException('Unknown kind must fail'); }
catch (RuntimeException $e) { if (!str_contains($e->getMessage(), 'tidak dikenal')) throw $e; }
if ($records->exists()) throw new RuntimeException('Failed migration did not roll back');
DB::table('production_records')->where('kind','unknown')->delete();
if (RecordMigration::run() !== count($fixtures)) throw new RuntimeException('Incorrect migrated count');
foreach ($fixtures as $kind=>$data) {
    if ($records->get($kind,$kind) != $data) throw new RuntimeException('Round trip mismatch: '.$kind);
}
$row = DB::table('production_entries')->where('record_id','entry')->first();
if ($row->operator !== 'Operator A' || (float)$row->qtyKardus !== 2.5) throw new RuntimeException('Columns not populated');
$records->put('entry','entry',['id'=>'entry-1','qtyKardus'=>7]);
if (isset($records->get('entry','entry')['operator'])) throw new RuntimeException('Replacement retained old columns');
$records->delete('entry','entry');
if (RecordMigration::run() !== 0 || $records->get('entry','entry') !== null) throw new RuntimeException('Setup resurrected deleted data');
if (DB::table('production_records')->count() !== count($fixtures)) throw new RuntimeException('Legacy backup changed');
echo "PASS: migration, rollback, all collections, readable columns, replacement, and repeated setup\n";
