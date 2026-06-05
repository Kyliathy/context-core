Add-Type -AssemblyName System.Security
$rawStr = Get-Content -Path 'C:\Users\Axonn\AppData\Roaming\Antigravity\Local State' -Raw
$rawJson = $rawStr | ConvertFrom-Json
$b64 = $rawJson.os_crypt.encrypted_key
$blob = [Convert]::FromBase64String($b64)
$encData = $blob[5..($blob.Length-1)]
$decData = [System.Security.Cryptography.ProtectedData]::Unprotect($encData, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($decData)
