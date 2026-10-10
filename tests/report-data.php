<?php
require dirname(__DIR__).'/private/bootstrap.php';

use App\Services\{Accounts, ApdService, Permissions, PressBalance, ProductionService, Records};
use App\Http\Controllers\ProductionController;

// Exercise the real response and permissions without connecting to a database.
$fixtures = [
    ['id' => 'fill-1', 'tab' => 'filling', 'tanggal' => '2026-10-08', 'operator' => 'Operator A'],
    ['id' => 'press-1', 'tab' => 'press', 'tanggal' => '2026-10-08', 'operator' => 'Operator A'],
];
$records = new class extends Records {
    public function all(string $kind): array { return []; }
    public function get(string $kind, string $id): ?array { return null; }
};
$production = new class($records, new PressBalance()) extends ProductionService {
    public array $fixtures = [];
    public function entries(): array { return $this->fixtures; }
    public function master(): array { return []; }
    public function model(): array { return ['remainders' => []]; }
};
$production->fixtures = $fixtures;
$accounts = new class extends Accounts {
    public function all(): array { return []; }
};
$controller = new ProductionController($accounts, $production, $records, new ApdService($production, $records));
$method = new ReflectionMethod($controller, 'appdata');
$cases = [
    'dashboard and all reports' => ['dashboard' => 'read', 'reports' => 'admin'],
    'KPI only without dashboard' => ['reports' => 'read', 'kpiFilling' => 'read'],
    'Kashift only without dashboard' => ['reports' => 'read', 'kpiShift' => 'read'],
    'work report without dashboard' => ['reports' => 'read', 'workReport' => 'read'],
    'production without reports' => ['filling' => 'read'],
];
foreach ($cases as $label => $levels) {
    $user = ['role' => 'user', 'permissions' => Permissions::normalize('user', ['levels' => $levels])];
    $response = $method->invoke($controller, $user);
    $expected = $label === 'production without reports' ? [] : $fixtures;
    if ($response['reportEntries'] !== $expected) throw new RuntimeException('FAIL: '.$label);
    $shared = $label === 'dashboard and all reports';
    if ($response['reportEntriesSameAsEntries'] !== $shared) throw new RuntimeException('FAIL shared flag: '.$label);
    if ($shared && $response['entries'] !== $response['reportEntries']) throw new RuntimeException('FAIL dashboard/report mismatch');
    echo 'PASS: '.$label.PHP_EOL;
}
