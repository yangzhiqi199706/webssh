<#
用法：以管理员或普通用户运行此脚本来持久化设置 OPENAI_API_KEY

立即在当前 PowerShell 会话中生效（仅当前会话）：
  $env:OPENAI_API_KEY = "sk-..."

持久化为当前用户（脚本默认行为）：
  .\set-openai-key.ps1 -ApiKey "sk-..."

以管理员权限持久化为机器级环境变量（需要管理员运行 PowerShell）：
  Start-Process powershell -Verb runAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "./set-openai-key.ps1" -ApiKey "sk-..." -Machine'

运行后请重启 VS Code 以使扩展读取到新的环境变量。
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$ApiKey,
    [switch]$Machine
)

try {
    if ($Machine) {
        # 需要管理员权限
        $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
        if (-not $isAdmin) {
            Write-Error "需要以管理员身份运行以设置机器级环境变量。"
            exit 1
        }
        [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $ApiKey, 'Machine')
        Write-Output "已将 OPENAI_API_KEY 写入 Machine 环境变量。"
    } else {
        [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $ApiKey, 'User')
        Write-Output "已将 OPENAI_API_KEY 写入当前用户环境变量。"
    }

    Write-Output "注意：某些程序（包括 VS Code）需要重启才能读取新的环境变量。"
    exit 0
} catch {
    Write-Error "设置环境变量失败：$($_.Exception.Message)"
    exit 1
}
