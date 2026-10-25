; Jarvis installer for Windows, built by scripts/package-windows.mjs.
; Per-user install (no administrator rights) into a fixed folder, a Start menu
; shortcut, an entry in "Apps" for uninstalling, and "Open Jarvis" at the end.
; Keys (%APPDATA%\Jarvis) and the profile (%USERPROFILE%\.grok-bot) are user
; data and are kept on uninstall.

Unicode true
!include "MUI2.nsh"

!ifndef SOURCE_DIR
  !error "Pass -DSOURCE_DIR, -DOUTFILE and -DVERSION"
!endif
!ifndef OUTFILE
  !error "Pass -DSOURCE_DIR, -DOUTFILE and -DVERSION"
!endif
!ifndef VERSION
  !error "Pass -DSOURCE_DIR, -DOUTFILE and -DVERSION"
!endif

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jarvis"

Name "Jarvis"
OutFile "${OUTFILE}"
; Fixed, so uninstalling can remove the whole folder safely.
InstallDir "$LOCALAPPDATA\Programs\Jarvis"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Jarvis ${VERSION}"

!define MUI_ICON "${SOURCE_DIR}\jarvis.ico"
!define MUI_UNICON "${SOURCE_DIR}\jarvis.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Jarvis.exe"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Portuguese"
!insertmacro MUI_LANGUAGE "English"

Section "Jarvis"
  ; An older version may be running from this folder.
  nsExec::Exec 'taskkill /IM Jarvis.exe /F'
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Jarvis.lnk" "$INSTDIR\Jarvis.exe" "" "$INSTDIR\jarvis.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Jarvis"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\jarvis.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "grok-bot-0.18-reconstructed"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM Jarvis.exe /F'
  Delete "$SMPROGRAMS\Jarvis.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; "Start at login", if it was turned on from the tray menu.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Jarvis"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Jarvis"
SectionEnd
