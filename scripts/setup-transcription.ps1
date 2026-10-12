param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$revision = 'c4d6cc0e5ec3904fdb64b350b2656b8e3ff33d53'
$checkout = Join-Path $project '.tools\vrfkit-transcription'
$cargo = Join-Path $project '.tools\cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $cargo)) {
    throw 'The project-local Rust toolchain is missing. Run scripts/setup-replay-analysis.ps1 first.'
}
if (-not (Test-Path -LiteralPath $checkout)) {
    git clone --no-checkout https://github.com/yakisoba0728/vrfkit.git $checkout
    if ($LASTEXITCODE -ne 0) { throw 'Could not download vrfkit' }
    git -C $checkout checkout $revision
    if ($LASTEXITCODE -ne 0) { throw 'Could not select the pinned decoder' }
} elseif ((git -C $checkout rev-parse HEAD).Trim() -ne $revision) {
    throw "Existing transcription decoder differs from the pinned revision $revision."
}
$executable = Join-Path $checkout 'target\release\vrfkit.exe'
if (-not (Test-Path -LiteralPath $executable)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vsPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
    if (-not $vsPath) { throw 'Visual C++ Build Tools are required to compile vrfkit.' }
    Import-Module (Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
    Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
    $env:RUSTUP_HOME = Join-Path $project '.tools\rustup'
    $env:CARGO_HOME = Join-Path $project '.tools\cargo'
    & $cargo +1.86.0 build --release -p vrfkit --locked --manifest-path (Join-Path $checkout 'Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw 'Decoder compilation failed.' }
}
if (-not $PythonPath) { $PythonPath = (Get-Command python.exe -ErrorAction Stop).Source }
$venv = Join-Path $project '.venv-replay'
$python = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    & $PythonPath -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
}
& $python -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'transcription-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Transcription dependency installation failed.' }
$mappings = Join-Path $project '.tools\fmodel\mappings\VALORANT_13.06_zs.usmap'
New-Item -ItemType Directory -Force -Path (Split-Path $mappings) | Out-Null
if (-not (Test-Path -LiteralPath $mappings)) {
    Invoke-WebRequest -UseBasicParsing 'https://data.uedb.dev/mappings/68c7964faa9ff725d91c8302/VALORANT_13.06_zs.usmap' -OutFile $mappings
}
$expected = '5555dd628883df9d9f68272a2099e4f7bfc15bcdcc8cb9bf31216a61bb1174dc'
if ((Get-FileHash -LiteralPath $mappings -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'The mapping checksum does not match UEDB.'
}
Write-Host 'Transcription decoder and Python dependencies are ready.'
Write-Host 'Map extraction also uses the existing staged FModel, .NET 10 and pythonnet libraries under .tools.'
