# Native verification runs as a disposable standard account on a GitHub-hosted VM.
param([string]$FixtureSid)
$ErrorActionPreference = 'Stop'
if ($FixtureSid) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $who = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($identity.User.Value -ne $FixtureSid -or $identity.Name -notmatch '\\AgsQuota[0-9a-f]{10}$' -or
        $who.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Expected the disposable standard user.' }
    $profile = [Environment]::GetFolderPath('UserProfile')
    if (-not $profile -or (Split-Path $profile -Leaf) -ine $identity.Name.Split('\')[-1]) { throw 'Expected its loaded profile.' }
    $env:TEMP = $env:TMP = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'
    [IO.Directory]::CreateDirectory($env:TEMP) | Out-Null
    # Secondary logon may supply a fresh environment. Copy only the three test flags.
    $env:GITHUB_ACTIONS = 'true'
    $env:RUNNER_ENVIRONMENT = 'github-hosted'
    $env:AGS_QUOTA_STANDARD_USER = '1'
    & .\node.exe --test --test-reporter=tap '--test-name-pattern=^Windows quota runner' tests/windows-usage-runner.test.cjs
    exit $LASTEXITCODE
}
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'This runner requires a disposable GitHub-hosted Windows VM.'
}
$name = 'AgsQuota' + [guid]::NewGuid().ToString('N').Substring(0, 10)
$password = ConvertTo-SecureString (([guid]::NewGuid().ToString('N')) + 'Aa1!') -AsPlainText -Force
$user = New-LocalUser -Name $name -Password $password
try {
    $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
    if (!(Get-LocalGroupMember -Group $usersGroup | Where-Object { $_.SID -eq $user.SID })) {
        Add-LocalGroupMember -Group $usersGroup -Member $user
    }
    # Do not grant access to the runner's profile, checkout or tool cache.
    $bundle = (New-Item -Type Directory -Path (Join-Path $env:ProgramData $name)).FullName
    & icacls.exe $bundle /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' ("*{0}:(OI)(CI)(RX)" -f $user.SID.Value) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare read-only fixture code.' }
    Copy-Item (Get-Command node.exe).Source (Join-Path $bundle 'node.exe')
    Copy-Item dist -Destination $bundle -Recurse
    foreach ($file in @('scripts/test-windows-quota.ps1', 'scripts/build-windows-helpers.cjs', 'tests/windows-usage-runner.test.cjs',
        'tests/helpers/windows-helper.cjs', 'tests/helpers/windows-quota-fixture.cs', 'assets/windows/AntigravityCredential.cs')) {
        $dest = Join-Path $bundle $file
        [IO.Directory]::CreateDirectory((Split-Path $dest -Parent)) | Out-Null
        Copy-Item -LiteralPath $file -Destination $dest
    }
    $auth = [System.Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name", $password)
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $argsList = '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "{0}" -FixtureSid "{1}"' -f (Join-Path $bundle 'scripts/test-windows-quota.ps1'), $user.SID.Value
    $log = Join-Path $env:RUNNER_TEMP $name
    $childProcess = Start-Process $shell -ArgumentList $argsList -WorkingDirectory $bundle -Credential $auth -LoadUserProfile -Wait -PassThru -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
    $output = Get-Content "$log.out"
    $output
    Get-Content "$log.err"
    if ($childProcess.ExitCode -ne 0 -or $output -notcontains '# pass 1') { throw 'The standard-user native quota test did not pass.' }
} finally {
    try { if ($bundle) { Remove-Item -LiteralPath $bundle -Recurse -Force } }
    finally { Remove-LocalUser -SID $user.SID }
}
