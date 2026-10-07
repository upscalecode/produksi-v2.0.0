param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PhpArguments)
$phpCommand = Get-Command php -ErrorAction SilentlyContinue
if ($phpCommand) {
    & $phpCommand.Source @PhpArguments
    exit $LASTEXITCODE
}
$laragonPhp = Get-ChildItem -Path 'C:\laragon\bin\php\*\php.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if (!$laragonPhp) { throw 'PHP tidak ditemukan. Buka terminal Laragon atau tambahkan PHP 8.3+ ke PATH.' }
& $laragonPhp.FullName @PhpArguments
exit $LASTEXITCODE
