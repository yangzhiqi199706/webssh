@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

REM ============================================
REM  8081 src 一键打包脚本 (Windows)
REM
REM  - 默认打包 localhost_8081\wwwroot\src 目录为 tar.gz
REM  - 可拖一个文件夹到 .bat 上临时换源
REM  - 输出：C:\Users\杨治琪\Desktop\脚本运行\8081更新打包\8081-src-YYYYMMDDHHMMSS.tar.gz
REM
REM  喂给 webssh：浏览器打开 http://192.168.0.22:3010
REM  -> 设置 -> 更新 -> 选择生成的 .tar.gz 文件
REM ============================================

REM 源目录：默认 localhost_8081\wwwroot\src；命令行参数 / 拖拽文件夹会覆盖
if "%~1"=="" (
    set "SRC_DIR=C:\Users\杨治琪\Desktop\脚本运行\localhost_8081\wwwroot\src"
) else (
    set "SRC_DIR=%~1"
)

REM 去掉路径末尾可能的反斜杠
if "!SRC_DIR:~-1!"=="\" set "SRC_DIR=!SRC_DIR:~0,-1!"

if not exist "%SRC_DIR%\" (
    echo.
    echo [错误] 找不到目录：%SRC_DIR%
    echo.
    pause
    exit /b 1
)

set "OUT_DIR=C:\Users\杨治琪\Desktop\脚本运行\8081更新打包"
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

REM 用 PowerShell 拿时间戳，跨 Win10/11 都稳（wmic 在新版被弃用）
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMddHHmmss"') do set "TS=%%I"
set "OUT_PATH=%OUT_DIR%\8081-src-!TS!.tar.gz"

echo.
echo ============================================
echo  8081 src 打包
echo ============================================
echo  源目录：%SRC_DIR%
echo  输出：  %OUT_PATH%
echo ============================================
echo.

REM 检查 tar
where tar >nul 2>&1
if errorlevel 1 (
    echo [错误] 找不到 tar 命令。
    echo        请安装 Git for Windows，或确认系统自带 tar 在 PATH 中。
    pause
    exit /b 1
)

REM Detect tar flavor:
REM   GNU tar (Git for Windows): needs --force-local for Windows paths.
REM   BSD tar / libarchive (Win10/11 builtin): does NOT support --force-local.
set "TAR_FORCE_LOCAL="
tar --version 2>nul | findstr /I "GNU" >nul
if not errorlevel 1 set "TAR_FORCE_LOCAL=--force-local"

echo [1/2] 正在打包...
REM -C SRC_DIR .  ：打包 src 内容（不是 src 这一层），解压时直接落到目标 src/ 内
tar %TAR_FORCE_LOCAL% -czf "%OUT_PATH%" ^
    --exclude=.DS_Store ^
    --exclude=.git ^
    --exclude=node_modules ^
    --exclude=Thumbs.db ^
    --exclude=*.log ^
    -C "%SRC_DIR%" .
if errorlevel 1 (
    echo.
    echo [错误] tar 打包失败
    pause
    exit /b 1
)
if not exist "%OUT_PATH%" (
    echo.
    echo [错误] 输出文件未生成
    pause
    exit /b 1
)

REM 文件大小
for %%I in ("%OUT_PATH%") do set "SIZE=%%~zI"
set /a "SIZE_KB=!SIZE! / 1024"
set /a "SIZE_MB=!SIZE_KB! / 1024"

echo [2/2] 打包完成
echo.
echo ============================================
echo  完成
echo ============================================
echo  文件：%OUT_PATH%
echo  大小：!SIZE! 字节 (约 !SIZE_KB! KB / !SIZE_MB! MB)
echo ============================================
echo.
echo  下一步：浏览器打开 http://192.168.0.22:3010
echo          设置 → 更新 → 选择上面生成的 .tar.gz
echo.

REM 自动在资源管理器中高亮显示新生成的文件
explorer.exe /select,"%OUT_PATH%"

pause
endlocal
