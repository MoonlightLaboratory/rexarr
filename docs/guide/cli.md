# The command line

`rexarr-cli` drives a running Rexarr from a script: rip the disc in a drive, see what the drives hold, swap a
stack through. It ships in every Rexarr package next to `rexarr` and `rexarr-agent`.

```bash
rexarr-cli rip --drive 1 --profile anime --wait
```

It is a client and nothing else. It holds no state, reads no configuration and talks to a running Rexarr over the
same HTTP API the web UI uses — so anything it does you can watch happen in a browser, and a box with no screen
needs nothing else installed. It does not have to run on the same machine.

## Where Rexarr is

| | |
| --- | --- |
| `--server URL` | default `http://localhost:3939`, or the `REXARR_URL` environment variable |
| `--key KEY` | the API key, when **Settings → General → Security** has one, or `REXARR_API_KEY` |

```bash
export REXARR_URL=http://nas:3939
export REXARR_API_KEY=…            # Settings → General → Security
rexarr-cli status
```

## Commands

| Command | What it does |
| --- | --- |
| `status` | the server, its drives, and anything running |
| `drives` | the drives and what is in them |
| `discs` | the discs in the queue; `--all` includes the finished ones |
| `detect` | look for discs now, rather than waiting for the next poll |
| `rip --drive N` | rip the disc in a drive |
| `swap --drive N` · `swap --all` | eject a drive whose disc has been copied, and wait for the next disc of its set |

A drive is the number `drives` prints, its device path, or the label of the disc in it — whichever is easier to
type. `rexarr-cli rip --drive NARUTO_D2` works, and so does `--drive /dev/sr0`.

## Ripping

`rip` uses what has already been decided for that disc — the titles, the episode numbers, the profile — which is
what the Discs page would have used had you pressed the button there. If the disc has not been read yet, it is
read first.

| | |
| --- | --- |
| `--profile NAME` | encode with this profile instead. Matched on the name, exactly before loosely, so `anime` finds *Anime · 1080p x265*; a name that fits more than one is refused rather than guessed at. Smart profiles count |
| `--no-transcode` | rip only, no encode |
| `--no-deliver` | do not hand the files to Radarr or Sonarr |
| `--wait` | stay until it is finished, printing progress as it goes |

Without `--wait` it returns as soon as the rip has started, which is what you want when a script is feeding
several drives.

## For scripts

`--json` prints the same thing as JSON. **Exit codes are 0 when the thing asked for happened and 1 when it did
not** — including `--wait` on a rip that failed — so a shell script can branch on it:

```bash
for drive in 0 1; do
  rexarr-cli rip --drive "$drive" --profile anime --wait || echo "drive $drive failed" >&2
done
rexarr-cli swap --all
```

Errors go to standard error, prefixed with `rexarr-cli:`, so they do not land in the middle of piped JSON.
