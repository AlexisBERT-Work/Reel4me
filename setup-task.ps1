<#
    Enregistre la tache quotidienne qui remplit le feed.

    Usage :
        powershell -ExecutionPolicy Bypass -File .\setup-task.ps1
        powershell -ExecutionPolicy Bypass -File .\setup-task.ps1 -At 03:30
        powershell -ExecutionPolicy Bypass -File .\setup-task.ps1 -Remove
#>

[CmdletBinding()]
param(
    [string] $TaskName = 'Reel4me',
    [string] $At = '04:00',
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'

$pipelineDir = Join-Path $PSScriptRoot 'pipeline'
$runScript = Join-Path $pipelineDir 'run.mjs'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Tache '$TaskName' supprimee."
    return
}

if (-not (Test-Path $runScript)) {
    throw "run.mjs introuvable dans $pipelineDir"
}
if (-not (Test-Path (Join-Path $pipelineDir '.env'))) {
    Write-Warning "pipeline\.env est absent : la tache echouera tant qu'il n'est pas cree (voir .env.example)."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node introuvable dans le PATH.' }

$action = New-ScheduledTaskAction -Execute $node -Argument 'run.mjs' -WorkingDirectory $pipelineDir
$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -RunOnlyIfNetworkAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew

# LogonType Interactive = "Executer seulement si l'utilisateur est connecte".
# Obligatoire : les identifiants OAuth de Claude Code ne sont lisibles que
# dans la session de l'utilisateur. En mode "S3" (compte de service), la
# generation echouerait sur une erreur d'authentification.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Description 'Ingere HN / arXiv / RSS, genere les cartes via Claude Code, publie dans Supabase.' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host ""
Write-Host "Tache '$TaskName' enregistree : tous les jours a $At." -ForegroundColor Green
Write-Host "  Rattrapage si le PC etait eteint : oui"
Write-Host "  Sortie de veille pour s'executer  : oui"
Write-Host ""
Write-Host "Declencher une fois maintenant :  schtasks /run /tn $TaskName"
Write-Host "Voir les logs                    :  pipeline\logs\"
Write-Host "Supprimer                        :  .\setup-task.ps1 -Remove"
