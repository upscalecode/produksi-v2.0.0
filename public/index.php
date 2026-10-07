<?php
require dirname(__DIR__).'/bootstrap.php';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if ($path === '/' || $path === '/index.php') {
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__.'/index.html'); exit;
}
if (!in_array($path, ['/api', '/api/production'], true)) {
    http_response_code(404); echo 'Halaman tidak ditemukan.'; exit;
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
try {
    if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'POST'], true)) {
        http_response_code(405); header('Allow: GET, POST');
        throw new DomainException('Metode HTTP tidak didukung.');
    }
    $records = new App\Services\Records();
    $production = new App\Services\ProductionService($records, new App\Services\PressBalance());
    $controller = new App\Http\Controllers\ProductionController(new App\Services\Accounts(), $production, $records, new App\Services\ApdService($production, $records));
    $result = $controller(App\Request::capture());
} catch (JsonException|DomainException $e) {
    $result = ['ok' => false, 'message' => $e instanceof JsonException ? 'Format data JSON tidak valid.' : $e->getMessage()];
} catch (Throwable $e) {
    error_log((string) $e); http_response_code(500);
    $result = ['ok' => false, 'message' => 'Server gagal memproses permintaan. Periksa konfigurasi MySQL dan log PHP.'];
}
echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
