param(
    [Parameter(Mandatory = $true)][string]$ReplayPath,
    [string]$MapDirectory,
    [string]$OutputDirectory,
    [string]$NamesPath,
    [string]$AssetModelPath,
    [switch]$ExtractMap
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$replay = (Resolve-Path -LiteralPath $ReplayPath).Path
$decoder = Join-Path $project '.tools\vrfkit-transcription\target\release\vrfkit.exe'
$python = Join-Path $project '.venv-replay\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $decoder) -or -not (Test-Path -LiteralPath $python)) {
    throw 'Run scripts/setup-transcription.ps1 first.'
}
$matchId = [IO.Path]::GetFileNameWithoutExtension($replay)
$root = Join-Path $project ".local\replay-transcripts\$matchId"
New-Item -ItemType Directory -Force -Path $root | Out-Null
# Each command validates the source and keeps a fresh export tied to its hashes.
$runId = [Guid]::NewGuid().ToString('N')
$run = Join-Path $root "runs\$runId"
$export = Join-Path $run 'export'
New-Item -ItemType Directory -Force -Path $run | Out-Null
& $decoder validate $replay --diagnostics *> (Join-Path $run 'validate.txt')
if ($LASTEXITCODE -ne 0) { throw "Replay validation failed; see $run\validate.txt" }
& $decoder export $replay --out $export --checkpoints *> (Join-Path $run 'export.txt')
if ($LASTEXITCODE -ne 0) { throw "Replay export failed; see $run\export.txt" }
$manifest = Get-Content -LiteralPath (Join-Path $export 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.replay_build -ne '++Ares-Core+release-13.06') {
    throw "This workflow pins map mappings to 13.06; replay is $($manifest.replay_build). Select matching assets/mappings explicitly with the Python tools."
}
$provenance = @{
    source_replay_sha256 = (Get-FileHash -LiteralPath $replay -Algorithm SHA256).Hash.ToLowerInvariant()
    decoder_sha256 = (Get-FileHash -LiteralPath $decoder -Algorithm SHA256).Hash.ToLowerInvariant()
    decoder_revision = 'c4d6cc0e5ec3904fdb64b350b2656b8e3ff33d53'
}
$provenance | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'source-provenance.json') -Encoding utf8
$mapCode = ($manifest.level_names_and_times[0].name -split '/')[-1]
if (-not $MapDirectory) { $MapDirectory = Join-Path $project ".local\replay-transcripts\map-$mapCode-13.06" }
if ($ExtractMap -or -not (Test-Path -LiteralPath (Join-Path $MapDirectory 'map.json'))) {
    & $python (Join-Path $PSScriptRoot 'export-transcription-map.py') --map $mapCode --out $MapDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Local map extraction failed.' }
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'review' }
if (-not $AssetModelPath) {
    $AssetModelPath = Join-Path $run 'game-asset-model.json'
    & $python (Join-Path $PSScriptRoot 'inspect-transcription-assets.py') --out (Join-Path $run 'asset-model-source.json') --model $AssetModelPath
    if ($LASTEXITCODE -ne 0) { throw 'Local gameplay asset extraction failed.' }
}
$arguments = @((Join-Path $PSScriptRoot 'build-replay-transcription.py'), $export, '--map', $MapDirectory, '--out', $OutputDirectory)
$arguments += @('--asset-model', (Resolve-Path -LiteralPath $AssetModelPath).Path)
if ($NamesPath) { $arguments += @('--names', (Resolve-Path -LiteralPath $NamesPath).Path) }
& $python @arguments
if ($LASTEXITCODE -ne 0) { throw 'Transcription generation failed.' }
Write-Host "Open the standalone viewer: $OutputDirectory\viewer.html"
