$ErrorActionPreference = 'Stop'
$aegisWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$aegisRuntime = Join-Path $aegisWorkspace 'work\asr-runtime'
$aegisModel = Join-Path $aegisWorkspace 'work\models\faster-whisper-tiny.en'
$aegisPython = Join-Path $aegisRuntime 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $aegisPython)) {
    throw "The existing AegisVoice runtime was not found at $aegisRuntime. This setup will not create a second virtual environment."
}
& $aegisPython -c "import sys; assert sys.prefix == r'$aegisRuntime', sys.executable" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "The existing runtime at $aegisRuntime is not usable on this machine. Repair it in place before running setup."
}
$freeBytes = (Get-Item -LiteralPath $aegisWorkspace).PSDrive.Free
if ($freeBytes -lt 6GB) { throw 'At least 6 GB of free space is required for the optional local models.' }
$env:PYTHONDONTWRITEBYTECODE = '1'
& $aegisPython -m pip install -r (Join-Path $PSScriptRoot 'ml\requirements-modern.txt')
if ($LASTEXITCODE -ne 0) { throw 'Speech dependency installation failed.' }
& $aegisPython (Join-Path $PSScriptRoot 'ml\install_modern_models.py')
if ($LASTEXITCODE -ne 0) { throw 'Speech and voice model installation failed.' }
Write-Output "Local speech recognition, Pella, AASIST, and ECAPA are ready in $aegisRuntime. Reload AegisVoice."
