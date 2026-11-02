!define FLOWNOTE_STATE_DIR "$LOCALAPPDATA\FlownoteData"
!define FLOWNOTE_CLI_BIN_DIR "$LOCALAPPDATA\Flownote\bin"
!define FLOWNOTE_CLI_SHIM "${FLOWNOTE_CLI_BIN_DIR}\flownote.cmd"
!define FLOWNOTE_LEGACY_CLI_SHIM "${FLOWNOTE_CLI_BIN_DIR}\flownote-cli.cmd"
!define FLOWNOTE_HELPER_SOURCE "${__FILEDIR__}\flownote-installer-helper.exe"
Var FlownoteSavedOutDir

!macro FLOWNOTE_BROADCAST_ENVIRONMENT_CHANGE
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, i 0, t "Environment", i 0, i 5000, *i .r0)'
!macroend

!macro FLOWNOTE_LOG message
  CreateDirectory "${FLOWNOTE_STATE_DIR}"
  FileOpen $R9 "${FLOWNOTE_STATE_DIR}\app-update.log" a
  ${If} $R9 != ""
    FileSeek $R9 0 END
    FileWrite $R9 "install=$INSTDIR ${message}$\r$\n"
    FileClose $R9
  ${EndIf}
!macroend

!macro FLOWNOTE_RECORD_SILENT_UPDATE_RESULT result message
  ${If} ${Silent}
  ${AndIf} ${FileExists} "${FLOWNOTE_STATE_DIR}\app-update-target.txt"
    CreateDirectory "${FLOWNOTE_STATE_DIR}"
    FileOpen $0 "${FLOWNOTE_STATE_DIR}\app-update-result.txt" w
    ${If} $0 != ""
      FileWrite $0 "${result}|${message}$\r$\n"
      FileClose $0
    ${EndIf}
  ${EndIf}
!macroend

; The standard template calls this for install and uninstall. Replace its
; name-only kill with a path-scoped preflight. Test when upgrading Tauri.
!ifmacrondef CheckIfAppIsRunning
  !error "Tauri CheckIfAppIsRunning macro is missing; review installer integration before upgrading Tauri."
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executableName productName
  StrCpy $FlownoteSavedOutDir $OUTDIR
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=flownote-installer-helper.exe "${FLOWNOTE_HELPER_SOURCE}"
flownote_preflight_retry:
  nsExec::ExecToLog '"$PLUGINSDIR\flownote-installer-helper.exe" --mode prepare --target "$INSTDIR" --main-executable "${executableName}" --source nsis --version "${VERSION}" --timeout-ms 30000 --interval-ms 200 --log "${FLOWNOTE_STATE_DIR}\app-update.log" --error-file "$PLUGINSDIR\flownote-error.txt"'
  Pop $1
  ${If} $1 != 0
    StrCpy $2 "Flownote could not prepare installation. See ${FLOWNOTE_STATE_DIR}\app-update.log."
    ClearErrors
    FileOpen $0 "$PLUGINSDIR\flownote-error.txt" r
    ${IfNot} ${Errors}
      FileReadUTF16LE $0 $2
      FileClose $0
    ${EndIf}
    !insertmacro FLOWNOTE_LOG "preflight-failed exit=$1 reason=$2"
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL|MB_DEFBUTTON2 "$2" IDRETRY flownote_preflight_retry
    ${EndIf}
    SetOutPath "$FlownoteSavedOutDir"
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$FlownoteSavedOutDir"
  ClearErrors
!macroend

; Tauri owns .onInstSuccess. Extraction failures also reach this callback.
Function .onInstFailed
  !insertmacro FLOWNOTE_LOG "installation-failed"
  !insertmacro FLOWNOTE_RECORD_SILENT_UPDATE_RESULT "failed" "Installation failed. Check the installer log and run setup again."
  SetErrorLevel 1
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; An older app updater wrote these markers beside its executable. Adopt only
  ; its update status, never its program directory or user data.
  ${If} ${Silent}
  ${AndIfNot} ${FileExists} "${FLOWNOTE_STATE_DIR}\app-update-target.txt"
  ${AndIf} ${FileExists} "$LOCALAPPDATA\Flownote\app-update-target.txt"
    CreateDirectory "${FLOWNOTE_STATE_DIR}"
    CopyFiles /SILENT "$LOCALAPPDATA\Flownote\app-update-target.txt" "${FLOWNOTE_STATE_DIR}\app-update-target.txt"
  ${EndIf}
!macroend

!macro FLOWNOTE_ADD_CLI_TO_USER_PATH
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 0
  StrCpy $2 1
  StrCpy $4 "$0;"
  ${Do}
    ClearErrors
    ${WordFind} "$4" ";" "E+$2" $3
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    ${If} $3 == "${FLOWNOTE_CLI_BIN_DIR}"
      StrCpy $1 1
      ${ExitDo}
    ${EndIf}
    IntOp $2 $2 + 1
  ${Loop}

  ${If} $1 == 0
    ${If} $0 == ""
      StrCpy $0 "${FLOWNOTE_CLI_BIN_DIR}"
    ${Else}
      StrCpy $0 "$0;${FLOWNOTE_CLI_BIN_DIR}"
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    !insertmacro FLOWNOTE_BROADCAST_ENVIRONMENT_CHANGE
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Visible/manual installs clear stale updater status without emitting a toast.
  IfSilent flownote_status_clear_done 0
  Delete "${FLOWNOTE_STATE_DIR}\app-update-result.txt"
  Delete "${FLOWNOTE_STATE_DIR}\app-update-target.txt"
flownote_status_clear_done:
  CreateDirectory "${FLOWNOTE_CLI_BIN_DIR}"
  Delete "${FLOWNOTE_LEGACY_CLI_SHIM}"
  FileOpen $0 "${FLOWNOTE_CLI_SHIM}" w
  ${If} $0 != ""
    FileWrite $0 "@echo off$\r$\n"
    FileWrite $0 "$\"$INSTDIR\flownote-cli.exe$\" %*$\r$\n"
    FileClose $0
  ${EndIf}
  !insertmacro FLOWNOTE_ADD_CLI_TO_USER_PATH
  !insertmacro FLOWNOTE_LOG "installation-complete"
  !insertmacro FLOWNOTE_RECORD_SILENT_UPDATE_RESULT "success" ""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "${FLOWNOTE_CLI_SHIM}"
  Delete "${FLOWNOTE_LEGACY_CLI_SHIM}"
  RMDir "${FLOWNOTE_CLI_BIN_DIR}"
  ; Runtime data and old recovery folders belong to the user.
!macroend
