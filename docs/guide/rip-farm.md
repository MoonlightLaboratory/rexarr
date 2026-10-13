# Rip farm

One Rexarr with the library on it, and as many other machines as you have drives for. A **rip farm** is a central
server and a set of **agents**: a Pi with a USB Blu-ray drive on a shelf, an old desktop with a fast CPU, a NUC
next to the disc pile. They all take work from the same queue.

An agent is deliberately thin. It has MakeMKV, or FFmpeg, or both, and it runs what the server tells it to run,
reporting progress back. It holds no library, no profiles and no metadata, and it decides nothing — identifying a
disc, resolving a profile, naming the file, talking to Radarr and Sonarr all stay on the server. That is what
makes a shelf of SBCs useful: a Pi can read a disc at full speed even though it could never encode one.

## What you need

* **Rexarr on the server**, with **Settings → Connections → Rip farm** switched on. Until it is, an agent is
  turned away and says so.
* **`rexarr-agent` on each machine**, which ships in every Rexarr package.
* **A folder both machines can see.** The files never travel over this connection — the agent writes a rip
  straight into the shared folder and the server picks it up from there. NFS, SMB, whatever you already use.

## Starting an agent

```bash
rexarr-agent --server http://nas:3939 --key <your API key>
```

The API key is under **Settings → General → Security**. Everything can come from the environment instead
(`REXARR_SERVER`, `REXARR_API_KEY`, `REXARR_AGENT_NAME`), which is what you want in a systemd unit or a container.

| Flag | What it does |
| --- | --- |
| `--server <url>` | the Rexarr to report to |
| `--key <key>` | that server's API key |
| `--name <name>` | what to call this machine on the Agents list (default: its hostname) |
| `--config <dir>` | where the agent keeps its id (default: `~/.rexarr-agent`) |
| `--ffmpeg` / `--makemkv` | the binaries, when they are not where they usually live |
| `--virtual-drives <dir>` | offer every disc image and DVD/Blu-ray folder in a directory as a drive |

On first run the agent makes an id and keeps it, so a restart rejoins as the same machine rather than appearing
twice. It prints what it found — MakeMKV, FFmpeg, the encoders, the hardware — and that is what the server shows:

```
Rexarr agent 0.1.8.0 on shelf-pi-1 (linux/arm64)
  ripping:    yes – MakeMKV 1.18.4
  encoding:   yes – 7.1
  reporting to http://nas:3939
Waiting to be approved on the server (Settings → Connections → Rip farm).
```

It keeps retrying rather than giving up, and says which of the three it is when something is wrong: the server
not answering at all, the API key being refused, or rip farm mode being off there.

### Keeping it running

The agent is a foreground program that reconnects on its own, so it only needs something to start it at boot.
On Linux, a unit of its own:

```ini
# /etc/systemd/system/rexarr-agent.service
[Unit]
Description=Rexarr agent
After=network-online.target remote-fs.target
Wants=network-online.target

[Service]
ExecStart=/opt/rexarr/rexarr-agent
Environment=REXARR_SERVER=http://nas:3939
Environment=REXARR_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Environment=REXARR_AGENT_NAME=shelf-pi-1
Restart=always
RestartSec=10
User=rexarr
SupplementaryGroups=cdrom

[Install]
WantedBy=multi-user.target
```

`After=remote-fs.target` matters: the share has to be mounted before the agent starts taking work, or it will be
handed a path that is not there yet. `SupplementaryGroups=cdrom` is what lets it reach the drive on most
distributions. Then `systemctl enable --now rexarr-agent`, and `journalctl -fu rexarr-agent` to watch it.

In Docker, the same image runs either side — pass the drive through and override the command:

```yaml
rexarr-agent:
  image: ghcr.io/moonlightlaboratory/rexarr:latest
  command: ["node", "server/dist/server/src/agent/main.js"]
  environment:
    REXARR_SERVER: http://rexarr:3939
    REXARR_API_KEY: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    REXARR_AGENT_NAME: shelf-pi-1
  devices: ["/dev/sr0:/dev/sr0", "/dev/sg0:/dev/sg0"]
  volumes: ["/mnt/media:/mnt/media"]
```

## Approving it

A new agent waits on **Settings → Connections → Rip farm** until you approve it, because an agent is given the paths of your
library and runs what it is told; it should be a machine you put there on purpose. Approve it there, set how many
tasks it takes at once, and give it a path mapping if it mounts the share somewhere else than the server does:

```
/Volumes/Media = /mnt/media
```

Left of the `=` is what the server calls the folder, right is what that agent calls it. Every path in every
command is rewritten on the way out, the `file:`/`iso:` sources MakeMKV takes included. The longest mapping wins,
so a fast scratch disk mapped inside the general share works.

## What it does

**Drives.** Every optical drive an agent can see appears on the **Discs** page named after the machine it is in —
*Pioneer BD-RW · shelf-pi-1*. Insert a disc there and Rexarr notices, scans it on that agent, identifies it here,
and rips it there.

**Encodes.** Any agent with FFmpeg can take jobs off the transcode queue. The server picks the one with the least
on, and only one that has the encoder the profile asked for — an agent whose FFmpeg has no `libsvtav1` is never
given an AV1 encode. **Keep this many encodes here first** reserves the first few for the server itself, so a
single-agent farm does not send everything away from the machine with the library on it.

The job log says which machine ran it (*Running on agent "shelf-pi-1"*), and the progress bar, the stall
timeout and **Cancel** behave exactly as they do for a local encode.

## How it talks

Agents pull. Nothing is pushed to an agent and nothing listens on one: it polls the server every few seconds,
says what it is running and how far along, and is told what to start and what to drop. A shelf of SBCs behind a
router therefore needs no ports forwarded, no certificates and no accounts — just the API key.

An agent only ever runs the two programs it was started with. The server sends a program and its arguments; a
task naming anything else is refused and logged. The server is trusted to say *encode this*, not *run this*.

An agent that stops polling is treated as gone after a minute and a half, and whatever it was running goes back
on the queue. With a shared folder the half-written file is still there, and the server cleans it up as it would
its own.

## What this is not, yet

* An agent does not update itself; upgrade it with the rest of Rexarr.
* A rip that was interrupted when an agent died is queued again from the start, not resumed.
* There is no per-agent profile or schedule: an agent either takes work or it does not.
