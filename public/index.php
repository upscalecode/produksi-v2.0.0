<?php
// Hosting: prefer the private directory outside public_html, then its protected fallback.
$bootstrap = null;
foreach ([dirname(__DIR__).'/private/bootstrap.php', __DIR__.'/private/bootstrap.php', dirname(__DIR__).'/bootstrap.php'] as $candidate) {
    if (@is_file($candidate) && @is_readable($candidate)) {
        $bootstrap = $candidate;
        break;
    }
}
if ($bootstrap === null) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    exit('Backend belum tersedia. Periksa lokasi folder private dan izin akses PHP.');
}
require $bootstrap;
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
} catch (PDOException $e) {
    error_log((string) $e); http_response_code(500);
    $driverCode = (int) ($e->errorInfo[1] ?? 0);
    $message = match ($driverCode) {
        1044, 1045 => 'Akses MySQL ditolak. Periksa username, password, dan izin database pada koneksi.php atau DB_* di .env.',
        1049 => 'Database MySQL tidak ditemukan. Periksa nama database pada koneksi.php atau DB_NAME di .env.',
        2002, 2003, 2005 => 'Tidak dapat terhubung ke MySQL. Periksa host, port, dan status server database.',
        1146, 1054 => 'Struktur database belum siap. Jalankan php bin/console.php setup menggunakan konfigurasi database hosting.',
        default => 'Operasi MySQL gagal. Periksa log PHP hosting untuk detail penyebabnya.',
    };
    $result = ['ok' => false, 'message' => $message];
} catch (Throwable $e) {
    error_log((string) $e); http_response_code(500);
    $result = ['ok' => false, 'message' => 'Server gagal memproses permintaan. Periksa konfigurasi MySQL dan log PHP.'];
}
echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
