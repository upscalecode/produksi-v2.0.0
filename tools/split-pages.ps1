param(
  [string]$Source = (Join-Path $PSScriptRoot "../public/index.html")
)

$ErrorActionPreference = "Stop"
$pageDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($Source))
$html = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
$sharedModalsPath = Join-Path $PSScriptRoot 'shared-modals.html'
if (-not (Test-Path -LiteralPath $sharedModalsPath)) {
  throw "Komponen bersama tidak ditemukan: $sharedModalsPath"
}
$sharedModals = Get-Content -LiteralPath $sharedModalsPath -Raw -Encoding UTF8
$views = [ordered]@{
  dashboard = "index.html"
  spk       = "spk.html"
  filling   = "filling.html"
  press     = "press.html"
  apd       = "apd.html"
  laporan   = "laporan.html"
  master    = "setting.html"
}

function Get-ViewBlock([string]$document, [string]$name) {
  $startPattern = '<section\b[^>]*\bid="view-' + [regex]::Escape($name) + '"[^>]*>'
  $startMatch = [regex]::Match($document, $startPattern, 'IgnoreCase')
  if (-not $startMatch.Success) { throw "View '$name' tidak ditemukan." }

  $tagPattern = [regex]'<section\b[^>]*>|</section\s*>'
  $depth = 0
  foreach ($match in $tagPattern.Matches($document, $startMatch.Index)) {
    if ($match.Value -match '^<section\b') { $depth++ } else { $depth-- }
    if ($depth -eq 0) {
      return $document.Substring($startMatch.Index, $match.Index + $match.Length - $startMatch.Index)
    }
  }
  throw "Penutup view '$name' tidak ditemukan."
}

$firstView = [regex]::Match($html, '<section\b[^>]*\bid="view-dashboard"[^>]*>', 'IgnoreCase')
$mainClose = $html.IndexOf('</main>', $firstView.Index, [StringComparison]::OrdinalIgnoreCase)
if (-not $firstView.Success -or $mainClose -lt 0) { throw 'Struktur <main> tidak dikenali.' }

$prefix = $html.Substring(0, $firstView.Index)
$suffix = $html.Substring($mainClose)
$blocks = @{}
foreach ($name in $views.Keys) {
  # Setiap file halaman menjadi sumber kanonis untuk view miliknya. Dengan
  # demikian perubahan pada laporan.html tidak tertimpa oleh salinan index.html.
  $sourceDocument = Get-Content -LiteralPath (Join-Path $pageDirectory $views[$name]) -Raw -Encoding UTF8
  $blocks[$name] = Get-ViewBlock $sourceDocument $name
}

$navPattern = '(?s)<nav class="tabbar" id="mainTabbar">.*?</nav>'
foreach ($current in $views.Keys) {
  $links = foreach ($name in $views.Keys) {
    $label = if ($name -eq 'master') { 'SETTING' } else { $name.ToUpperInvariant() }
    $id = if ($name -eq 'master') { ' id="masterTabBtn" hidden' } else { '' }
    $active = if ($name -eq $current) { ' active' } else { '' }
    '          <button type="button" class="tab-btn' + $active + '" data-view="' + $name + '"' + $id + '>' + $label + '</button>'
  }
  $nav = "        <nav class=`"tabbar`" id=`"mainTabbar`">`r`n" + ($links -join "`r`n") + "`r`n        </nav>"
  $pagePrefix = [regex]::Replace($prefix, $navPattern, $nav)
  $pagePrefix = $pagePrefix -replace '<body data-page="app"(?:\s+data-active-view="[^"]+")?>', ('<body data-page="app" data-active-view="' + $current + '">')

  # Semua view disertakan sejak awal agar render data dan event handler selalu
  # mendapat DOM lengkap. File/URL tetap terpisah dan menentukan view awal.
  $pageBlocks = foreach ($name in $views.Keys) {
    $block = $blocks[$name]
    $open = [regex]::Match($block, '<section\b[^>]*\bid="view-' + [regex]::Escape($name) + '"[^>]*>', 'IgnoreCase')
    if (-not $open.Success) { throw "Tag pembuka halaman '$name' tidak ditemukan." }
    $normalizedOpen = [regex]::Replace($open.Value, '\s+hidden(?=\s|>)', '', 'IgnoreCase')
    if ($name -ne $current) {
      $normalizedOpen = $normalizedOpen.Substring(0, $normalizedOpen.Length - 1) + ' hidden>'
    }
    $block.Substring(0, $open.Index) + $normalizedOpen + $block.Substring($open.Index + $open.Length)
  }
  $content = $pageBlocks -join "`r`n`r`n        "
  $output = $pagePrefix + $content + "`r`n`r`n        " + $sharedModals.Trim() + "`r`n      " + $suffix
  $output = $output -replace 'style\.css\?v=[^"'']+', 'style.css?v=20261003-v112-damage-card-tooltip'
  $output = $output -replace 'script\.js\?v=[^"'']+', 'script.js?v=20261003-v204-damage-card-tooltip'
  Set-Content -LiteralPath (Join-Path $pageDirectory $views[$current]) -Value $output -Encoding UTF8
}

Write-Host ('Halaman dibuat: ' + (($views.Values | Select-Object -Unique) -join ', '))
