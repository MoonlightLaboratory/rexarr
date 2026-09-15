; rexarr Windows installer (Inno Setup 6), built by .github/workflows/release.yml from the win-x64 / win-x86 zip:
;
;   iscc /DAppVersion=0.1.4.1 /DArch=x64 /DSourceDir=C:\stage\rexarr /DOutputDir=C:\out distribution\windows\rexarr.iss
;
; Installs to Program Files\rexarr; data stays in C:\ProgramData\rexarr (kept on uninstall and upgrade).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Arch
  #define Arch "x64"
#endif
#ifndef Branch
  #define Branch "main"
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<extracted rexarr folder from the win zip>
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#define RepoUrl "https://github.com/MoonlightLaboratory/rexarr"

[Setup]
AppId={{5B8E2C4A-7F13-4D69-9A2E-3C1D8B6F0E47}
AppName=rexarr
AppVersion={#AppVersion}
AppVerName=rexarr {#AppVersion}
AppPublisher=MoonlightLaboratory
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
AppUpdatesURL={#RepoUrl}/releases
AppCopyright=Copyright 2026 MoonlightLaboratory
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\rexarr
DefaultGroupName=rexarr
DisableProgramGroupPage=yes
DisableDirPage=auto
LicenseFile={#SourceDir}\LICENSE.md
OutputDir={#OutputDir}
OutputBaseFilename=rexarr.{#Branch}.{#AppVersion}.win-{#Arch}-installer
SetupIconFile={#SourcePath}\..\..\logo\rexarr.ico
UninstallDisplayIcon={app}\rexarr.ico
UninstallDisplayName=rexarr
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
MinVersion=10.0
#if Arch == "x64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif

[Tasks]
Name: desktopicon; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: startup; Description: "Start rexarr when I sign in"; GroupDescription: "Startup:"; Flags: unchecked

[InstallDelete]
; replace the app wholesale on upgrade so removed files do not linger (data is elsewhere)
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\client"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourcePath}\stop-rexarr.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\rexarr"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\rexarr.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\rexarr.ico"; Comment: "Start rexarr and open it in your browser"
Name: "{group}\rexarr (console)"; Filename: "{app}\rexarr.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\rexarr.ico"; Comment: "Run rexarr in a console window"
Name: "{group}\Open rexarr in browser"; Filename: "http://localhost:3939/"; IconFilename: "{app}\rexarr.ico"
Name: "{autodesktop}\rexarr"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\rexarr.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\rexarr.ico"; Tasks: desktopicon
Name: "{userstartup}\rexarr"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\rexarr.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\rexarr.ico"; Tasks: startup

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\rexarr.vbs"""; WorkingDir: "{app}"; Description: "Start rexarr"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\stop-rexarr.ps1"" -AppDir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "StopRexarr"

[Code]
const
  UrlFfmpeg = 'https://www.gyan.dev/ffmpeg/builds/';
  UrlFreac = 'https://github.com/enzo1982/freac/releases/latest';
  UrlMakemkv = 'https://www.makemkv.com/download/';
  UrlSlskd = 'https://github.com/slskd/slskd/releases/latest';

var
  ToolsPage: TInputOptionWizardPage;

function FfmpegFound: Boolean;
begin
  Result := FileSearch('ffmpeg.exe', GetEnv('PATH')) <> '';
end;

function FreacFound: Boolean;
begin
  Result := FileExists(ExpandConstant('{commonpf32}\freac\freaccmd.exe'));
  if (not Result) and IsWin64 then
    Result := FileExists(ExpandConstant('{commonpf64}\freac\freaccmd.exe'));
end;

function MakemkvFound: Boolean;
begin
  Result := FileExists(ExpandConstant('{commonpf32}\MakeMKV\makemkvcon64.exe')) or FileExists(ExpandConstant('{commonpf32}\MakeMKV\makemkvcon.exe'));
end;

// One checkbox per tool; ticked by default only for a missing required tool.
procedure AddTool(const Caption: String; Found, Required: Boolean);
var
  Index: Integer;
begin
  if Found then
    Index := ToolsPage.Add(Caption + '   (already installed)')
  else
    Index := ToolsPage.Add(Caption);
  ToolsPage.Values[Index] := Required and not Found;
end;

procedure InitializeWizard;
begin
  ToolsPage := CreateInputOptionPage(wpSelectTasks,
    'Recommended tools',
    'rexarr works with these free programs, which are installed separately.',
    'Tick the ones you want to download: their official download pages open in your browser when setup finishes. ' +
    'You can do this later too, under System > Tools in rexarr.',
    False, False);
  AddTool('FFmpeg - required: transcoding, media details and previews', FfmpegFound, True);
  AddTool('fre:ac - music profiles, audio CD ripping, cue sheet splitting', FreacFound, False);
  AddTool('MakeMKV - DVD and Blu-ray ripping, full-disc downloads', MakemkvFound, False);
  AddTool('slskd - Soulseek album search (runs as its own server)', False, False);
end;

procedure OpenPage(const Url: String);
var
  ErrorCode: Integer;
begin
  // as the signed-in user, not the elevated installer
  ShellExecAsOriginalUser('open', Url, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssDone) and not WizardSilent then
  begin
    if ToolsPage.Values[0] then OpenPage(UrlFfmpeg);
    if ToolsPage.Values[1] then OpenPage(UrlFreac);
    if ToolsPage.Values[2] then OpenPage(UrlMakemkv);
    if ToolsPage.Values[3] then OpenPage(UrlSlskd);
  end;
end;

// Stop a running rexarr from this folder before files are replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Dir: String;
begin
  Result := '';
  Dir := ExpandConstant('{app}');
  if FileExists(Dir + '\stop-rexarr.ps1') then
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + Dir + '\stop-rexarr.ps1" -AppDir "' + Dir + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
