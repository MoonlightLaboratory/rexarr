# Install from a release

Every [release](https://github.com/MoonlightLaboratory/rexarr/releases) has packages for each platform, named like
Sonarr's (`rexarr.main.<version>.<platform>`). Each one bundles Node.js; FFmpeg, fre:ac and MakeMKV are installed
separately (see [Requirements](requirements.md)).

| Platform | Package | How to run |
| --- | --- | --- |
| Windows 10 / 11 | `win-x64-installer.exe` (`win-x86-installer.exe` for 32-bit) | Run the installer, then **Rexarr** from the Start menu. Portable: `win-x64.zip`, run `rexarr.vbs` (no window) or `rexarr.cmd` (console) |
| macOS 11+ | `osx-arm64-app.zip` (Apple silicon), `osx-x64-app.zip` (Intel) | Unzip, move `Rexarr.app` to Applications and open it. Terminal: `osx-*.tar.gz`, run `rexarr/rexarr` |
| Linux (glibc: Debian, Ubuntu, Fedora…) | `linux-x64`, `linux-arm64`, `linux-arm` (32-bit Raspberry Pi OS) `.tar.gz` | `tar -xzf rexarr.main.*.tar.gz && ./rexarr/rexarr` |
| Linux (musl: Alpine) | `linux-musl-x64`, `linux-musl-arm64` `.tar.gz` | `apk add libstdc++`, then `./rexarr/rexarr` |
| FreeBSD | `freebsd-x64.tar.gz` (no bundled Node) | `pkg install node22`, then `./rexarr/rexarr` |

Then open **http://localhost:3939**.

On first launch Rexarr opens **System → Tools**, which checks for FFmpeg, fre:ac, MakeMKV and slskd and shows how to
install whichever is missing on your platform (winget / Homebrew / apt commands and the official download pages).
The Windows installer has the same list as a *Recommended tools* page: tick a tool and its download page opens when
setup finishes.

## Where your data lives

| Platform | Config root |
| --- | --- |
| Windows | `C:\ProgramData\rexarr` |
| macOS, Linux, FreeBSD | `~/.config/rexarr` |
| Docker | `/config` |

`REXARR_CONFIG_DIR` overrides it. Upgrading replaces the program files only — settings, profiles, history and logs
stay. See [Storage and environment](../reference/storage.md) for the full layout.

## Stopping and restarting

**System → Shutdown**, or close the console / press <kbd>Ctrl</kbd>+<kbd>C</kbd>. Launching Rexarr again while it is
already running just opens it in your browser.

## macOS: the app is not notarised

If macOS says it cannot be opened, open it once from Finder with right-click → *Open*, or allow it under
**System Settings → Privacy & Security → Open Anyway**.

## Linux as a service

With Rexarr extracted to `/opt/rexarr` and a `rexarr` user:

```ini
# /etc/systemd/system/rexarr.service
[Unit]
Description=Rexarr
After=network-online.target

[Service]
User=rexarr
UMask=0002
ExecStart=/opt/rexarr/rexarr
Restart=on-failure
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now rexarr
```

Data then lives in `/home/rexarr/.config/rexarr`, or set `Environment=REXARR_CONFIG_DIR=/var/lib/rexarr`.

For disc ripping the service user needs access to the optical drive (`cdrom` group on Debian / Ubuntu) — and, if you
want the machine to stay awake during long rips, see
[Keeping the computer awake](../guide/disc-ripping.md#keeping-the-computer-awake).

## Updating

Download the new package and install over the old one (Windows), replace the folder (macOS, Linux), or pull the new
image (Docker). Read the [release notes](../release-notes.md) first, and take a backup from **System → Backup** if
you are coming from an older minor version.
