$ErrorActionPreference = 'Stop'
$aegisWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$aegisRuntime = Join-Path $aegisWorkspace 'work\asr-runtime'
$aegisPython = Join-Path $aegisRuntime 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $aegisPython)) {
    throw "The existing AegisVoice runtime was not found at $aegisRuntime. This setup will not create a second virtual environment."
}
& $aegisPython -c "import sys; assert sys.prefix == r'$aegisRuntime', sys.executable" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "The existing runtime at $aegisRuntime is not usable on this machine. Repair it in place before running setup."
}
$freeBytes = (Get-Item -LiteralPath $aegisWorkspace).PSDrive.Free
if ($freeBytes -lt 12GB) { throw 'At least 12 GB of free space is required for source archives, extraction and training.' }
$env:PYTHONDONTWRITEBYTECODE = '1'
& $aegisPython -m pip install -r (Join-Path $PSScriptRoot 'ml\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
foreach ($aegisScript in @('download_data.py','install_mendeley_fake_audio.py','train_text.py','train_audio.py','validate_models.py')) {
    & $aegisPython (Join-Path $PSScriptRoot "ml\$aegisScript")
    if ($LASTEXITCODE -ne 0) { throw "$aegisScript failed. Read the output above." }
}
Write-Output 'Downloaded datasets, trained models and validated the artifacts. Start or reload AegisVoice.'
