<?php
require dirname(__DIR__).'/bootstrap.php';
use App\Database as DB;
use App\Request;
use App\Services\{Accounts, ApdService, Permissions, PressBalance, ProductionService, Records};

// Explicitly require an empty, dedicated test database. Never clear a user's database.
if (!preg_match('/_test$/', getenv('DB_NAME') ?: '')) throw new RuntimeException('DB_NAME harus berakhiran _test.');
foreach (['production_users','production_photos', ...array_values(Records::TABLES)] as $table) {
    if (DB::table($table)->exists()) throw new RuntimeException('Gunakan database pengujian kosong.');
}
set_error_handler(static function ($severity, $message, $file, $line) {
    if (error_reporting() & $severity) throw new ErrorException($message, 0, $severity, $file, $line);
});
$checks = 0;
function check(bool $value, string $label): void {
    global $checks; $checks++;
    if (!$value) throw new RuntimeException('FAIL: '.$label);
}
$records = new Records(); $accounts = new Accounts();
$production = new ProductionService($records, new PressBalance());
$controller = new App\Http\Controllers\ProductionController($accounts, $production, $records, new ApdService($production, $records));
$token = '';
function api(string $action, array $data = [], bool $expected = true, string $method = 'POST', ?string $auth = null): array {
    global $controller, $token;
    $result = $controller(new Request(['action' => $action] + $data, $method, 'Bearer '.($auth ?? $token)));
    check($result['ok'] === $expected, $action.' '.json_encode($result));
    return $result;
}
$accounts->add(['username'=>'admin','name'=>'Admin','password'=>'test-password','role'=>'superuser']);
check(password_verify('test-password', DB::table('production_users')->first()->password), 'Password hash');
for ($i=0;$i<5;$i++) api('login', ['username'=>'bad','password'=>'wrong'], false);
$blocked = api('login', ['username'=>'bad','password'=>'wrong'], false);
check(str_contains($blocked['message'], 'Terlalu banyak'), 'Login throttle persists');
$token = api('login', ['username'=>'admin','password'=>'test-password'])['token'];
check(DB::table('production_tokens')->where('hash', hash('sha256', $token))->exists(), 'Hashed bearer token');
api('entry.delete', ['id'=>'anything'], false, 'GET');
foreach (['operator'=>'Operator 1','produk'=>'Produk 1','botol'=>'Botol 1'] as $category=>$value) api('master.add', compact('category','value'));
$spk = ['produk'=>'Produk 1','botol'=>'Botol 1','produksiDus'=>10,'qtyPerDus'=>12];
$batch = api('spk.create', ['data'=>$spk])['spk']['batchNo'];
$entry = ['line'=>'filling','batchNo'=>$batch,'tanggal'=>date('Y-m-d'),'operator'=>'Operator 1','produk'=>'Produk 1','botol'=>'Botol 1','qtyKardus'=>5,'qtyBotolPerKardus'=>12,'clientRequestId'=>'request-1234567890'];
api('entry.batchCreate', ['data'=>[$entry, array_replace($entry,['line'=>'press','qtyKardus'=>6,'clientRequestId'=>'different-1234567890'])]], false);
check(count($records->all('entry')) === 0, 'Batch rollback');
$fill = api('entry.create',['data'=>$entry])['entry'];
api('entry.create',['data'=>$entry]);
check(count($records->all('entry')) === 1, 'Idempotent retry');
$press = array_replace($entry,['line'=>'press','qtyKardus'=>6,'clientRequestId'=>'']);
api('entry.create',['data'=>$press], false);
$press['qtyKardus']=2;
$pressed = api('entry.create',['data'=>$press])['entry'];
check($production->model()['remainders'][0]['sisaQty'] == 36, 'Press balance');
api('entry.delete',['id'=>$fill['id']],false);
api('spk.delete',['batchNo'=>$batch],false);
api('spk.update',['batchNo'=>$batch,'data'=>array_replace($spk,['produksiDus'=>20])],false);
api('entry.delete',['id'=>$pressed['id']]);
api('entry.delete',['id'=>$fill['id']]);
$restored = api('entry.create',['data'=>$entry])['entry'];
check($restored['updateCount'] === 1, 'Restore audit count');
$other = api('spk.create',['data'=>$spk])['spk']['batchNo'];
api('entry.create',['data'=>array_replace($press,['batchNo'=>$other])],false);
api('entry.create',['data'=>array_replace($press,['tanggal'=>date('Y-m-d', strtotime('-1 day'))])],false);
api('press.adjustment.closeBatch',['data'=>['rows'=>[['produk'=>'Produk 1','botol'=>'Botol 1','qtyBotolPerKardus'=>12,'targetBatchNo'=>$batch,'targetTanggalAsal'=>date('Y-m-d')]],'alasan'=>'Ditutup karena rusak']]);
check($production->model()['remainders'] === [], 'Closing press remainder');
api('entry.create',['data'=>$press],false);
$image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
$photo=api('apd.photo.upload',['dataUrl'=>$image])['photoFileId'];
$apd=['clientRequestId'=>'apd-request-12345678','tanggal'=>date('Y-m-d'),'operator'=>'Operator 1','scores'=>array_fill_keys(array_keys(ApdService::WEIGHTS),3),'photoFileIds'=>[$photo]];
$saved=api('apd.batchCreate',['data'=>[$apd]]);
check($saved['entries'][0]['percentage'] == 100, 'APD weighted score');
api('apd.photo.discard',['photoFileId'=>$photo],false);
check(count(api('apd.photo.get',['id'=>$apd['clientRequestId']],true,'GET')['dataUrls'])===1,'APD photo retrieval');
api('apd.batchCreate',['data'=>[array_replace($apd,['clientRequestId'=>'another-request-12345678'])]],false);
api('downtime.upsert',['data'=>['arrivalTimestamp'=>date('Y-m-d').'T09:00:00+07:00','alasan'=>'Menunggu QC']]);
check($records->all('downtime')[0]['downTime']===30,'Downtime timezone');
api('settings.kpiTargets.set',['fillingValue'=>200000,'pressValue'=>90000]);
api('settings.kpiTargets.set',['fillingValue'=>0,'pressValue'=>90000],false);
api('user.add',['username'=>'reader','name'=>'Reader','password'=>'test-password','role'=>'user']);
$reader=api('login',['username'=>'reader','password'=>'test-password'])['token'];
api('entry.delete',['id'=>$fill['id']],false,'POST',$reader);
api('apd.photo.preview',['photoFileId'=>$photo],false,'GET',$reader);
api('master.add',['category'=>'produk','value'=>'Forbidden'],false,'POST',$reader);
api('user.password.reset',['username'=>'reader','password'=>'another-password']);
api('bootstrap',[],false,'GET',$reader);
api('user.remove',['username'=>'admin'],false);
$snapshot=['schemaVersion'=>1,'master'=>$production->master(),'settings'=>['kpiFillingOutputTargetMonthly'=>150000,'kpiPressOutputTargetMonthly'=>70000],'users'=>$accounts->all(),'entries'=>$records->all('entry'),'spkEntries'=>$records->all('spk'),'apdEntries'=>$records->all('apd'),'adjustments'=>$records->all('adjustment'),'downtimeEntries'=>$records->all('downtime'),'audits'=>$records->all('audit'),'photos'=>[['id'=>$photo,'owner'=>'admin','dataUrl'=>$image]]];
$file=tempnam(sys_get_temp_dir(),'native-test-');
file_put_contents($file,json_encode($snapshot));
try {
    $importer=new App\ImportProduction();
    check($importer->run($file,false,$records)===0,'Snapshot dry run');
    check($importer->run($file,true,$records)===1,'Import refuses overwrite');
    // This database was explicitly verified as a disposable, empty test database at startup.
    foreach (array_keys(Records::TABLES) as $kind) $records->clear($kind);
    DB::table('production_photos')->delete();
    check($importer->run($file,true,$records)===0,'Snapshot applied');
    check(count($records->all('entry'))===1,'Imported entries');
    $newPhoto=$records->all('apd')[0]['photoFileIds'][0];
    check($newPhoto!==$photo && DB::table('production_photos')->where('id',$newPhoto)->exists(),'Imported photo relinked');
} finally { unlink($file); }
api('apd.delete',['id'=>$apd['clientRequestId']]);
check(DB::table('production_photos')->count()===0,'Unused photo removed');
api('logout'); api('bootstrap',[],false,'GET');
echo "PASS: $checks native PHP + MySQL checks\n";
