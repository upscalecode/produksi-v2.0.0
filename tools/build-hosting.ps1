param([ValidateSet('outside', 'inside')][string]$Layout = 'outside')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $projectRoot "deployment/$Layout"
# Never overwrite an existing package, which may contain hosting configuration.
if (Test-Path -LiteralPath $destination) { throw "Paket sudah ada: $destination. Pindahkan paket lama sebelum membuat ulang." }
$webRoot = Join-Path $destination 'public_html'
$privateRoot = if ($Layout -eq 'outside') { Join-Path $destination 'private' } else { Join-Path $webRoot 'private' }
New-Item -ItemType Directory -Path $webRoot, $privateRoot -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'public') -Force | Copy-Item -Destination $webRoot -Recurse -Force
foreach ($name in @('app', 'bin', 'bootstrap.php', 'koneksi.php')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $privateRoot -Recurse -Force
}
$databaseRoot = Join-Path $privateRoot 'database'
New-Item -ItemType Directory -Path $databaseRoot | Out-Null
foreach ($name in @('schema.sql', 'master-csv-migration.sql', 'operator-department-migration.sql')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "database/$name") -Destination $databaseRoot
}
Set-Content -LiteralPath (Join-Path $privateRoot '.htaccess') -Encoding ASCII -Value "Require all denied"
Write-Output "Paket siap: $destination"
Write-Output 'Konfigurasi koneksi.php disalin; paket bersifat privat. .env hosting tidak disalin atau ditimpa.'
