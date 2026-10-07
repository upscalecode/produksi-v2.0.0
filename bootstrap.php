<?php
// No Composer autoloader or framework is required.
date_default_timezone_set('Asia/Jakarta');
spl_autoload_register(static function (string $class): void {
    if (str_starts_with($class, 'App\\')) {
        $file = __DIR__.'/app/'.str_replace('\\', '/', substr($class, 4)).'.php';
        if (is_file($file)) require $file;
    }
});
$envFile = null;
// Support both a project outside the web root and a project in public_html.
foreach ([__DIR__.'/.env', dirname(__DIR__).'/.env'] as $candidate) {
    if (is_file($candidate)) {
        $envFile = $candidate;
        break;
    }
}
if ($envFile !== null) {
    $envLines = is_readable($envFile) ? file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : false;
    if ($envLines === false) throw new RuntimeException('File .env ditemukan tetapi tidak dapat dibaca. Periksa permission dan open_basedir PHP hosting.');
    foreach ($envLines as $line) {
        $line = preg_replace('/^\xEF\xBB\xBF/', '', $line);
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) continue;
        [$key, $value] = explode('=', $line, 2);
        $key = trim($key); $value = trim($value);
        if (!preg_match('/^[A-Z][A-Z0-9_]*$/', $key) || getenv($key) !== false) continue;
        if (strlen($value) >= 2 && (($value[0] === '"' && str_ends_with($value, '"')) || ($value[0] === "'" && str_ends_with($value, "'")))) $value = substr($value, 1, -1);
        putenv($key.'='.$value);
    }
}
define('APP_ENV_FILE', $envFile);
function timestamp(): string { return gmdate('Y-m-d\TH:i:s').'.000Z'; }
function uuid(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 15) | 64);
    $bytes[8] = chr((ord($bytes[8]) & 63) | 128);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
}
function indonesianDate(string $value): string
{
    $date = new DateTimeImmutable($value);
    $months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    return $date->format('j').' '.$months[(int) $date->format('n') - 1].' '.$date->format('Y');
}
