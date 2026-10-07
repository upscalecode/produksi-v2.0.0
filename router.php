<?php
// Development server router. Production uses public/.htaccess.
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$public = realpath(__DIR__.'/public');
$file = realpath($public.$path);
if ($path !== '/' && $file && str_starts_with($file, $public.DIRECTORY_SEPARATOR) && is_file($file)
    && !preg_match('~(?:^|[/\\\\])\.~', $path) && strtolower(pathinfo($file, PATHINFO_EXTENSION)) !== 'php') return false;
require __DIR__.'/public/index.php';
