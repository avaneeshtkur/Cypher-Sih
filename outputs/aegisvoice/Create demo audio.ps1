$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$demoDirectory = Join-Path $PSScriptRoot 'demo-audio'
New-Item -ItemType Directory -Force -Path $demoDirectory | Out-Null
$scripts = @{
    'payment-pressure' = 'Hello, this is the chief financial officer. I need you to transfer the money within the next twenty minutes. Use the new account details I sent you. Skip the usual approval. Keep this between us. Do not call me back. I am in a confidential meeting. Please send the money immediately.'
    'legitimate-payment' = 'Hello, I am calling about the supplier invoice. This payment is urgent. Please complete the usual approval. Verify the beneficiary with the finance team before sending any money. Call the vendor on our saved number. Follow the normal procedure. If anything does not match, wait for confirmation.'
    'digital-arrest' = 'This is the police officer handling your case. A case has been registered against your account and an arrest warrant is ready. Your account will be blocked today unless you cooperate. Transfer the money to the verification account I give you now. Do not tell anyone about this call. Skip the usual approval and stay on the line.'
    'refund-lure' = 'Congratulations, you have won our lucky draw prize money. A refund is also pending on your account. To claim your reward, complete your KYC verification immediately. Please read out the OTP you have just received so I can confirm your identity and release the amount today.'
}
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speaker.Rate = -1
try {
    foreach ($entry in $scripts.GetEnumerator()) {
        $speaker.SetOutputToWaveFile((Join-Path $demoDirectory ($entry.Key + '.wav')))
        $speaker.Speak($entry.Value)
        $speaker.SetOutputToNull()
    }
    $manifest = @{kind='Authored synthetic speech demos'; voice=$speaker.Voice.Name; created_at=(Get-Date).ToUniversalTime().ToString('o'); scripts=$scripts; limitations='Stock Windows text-to-speech. Not real victim calls, not downloaded scam audio, not training or evaluation data.'}
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $demoDirectory 'manifest.json') -Encoding UTF8
} finally { $speaker.Dispose() }
