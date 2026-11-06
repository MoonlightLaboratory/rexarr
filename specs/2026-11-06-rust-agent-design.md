# A Rust rexarr-agent, encoding only

*2026-11-06 · status: approved for planning*

## Why

`rexarr-agent` is the one part of Rexarr where Rust earns its keep. It is a small, self-contained program
whose whole job is to sit on a spare machine, run a binary somebody else chose, and report back. It holds no
profiles, no library, no metadata, and decides nothing. That is the opposite of the server, where the value is
in `shared/` — 3,254 lines of types and pure logic imported at 44 sites in the client and 121 in the server —
and where moving to Rust would mean either duplicating that logic or putting it behind HTTP.

The agent has almost none of that coupling. It imports `shared/types.js` for the wire shapes and
`shared/version.js` for a string. Everything else it does is process management.

What a Rust agent buys, concretely:

- **A static binary.** Today a rip farm node needs Node installed, or the full Rexarr package. ~8 MB with no
  runtime beats a Node install on a Pi.
- **~10 MB resident instead of ~60–80 MB**, on machines deliberately chosen for being spare.
- It is a **bounded experiment**. If Rust turns out not to suit this project, the loss is one small program,
  not a quarter.

This is not a step toward rewriting the server. The reasoning that makes the agent a good candidate is the
same reasoning that makes the server a bad one.

## Scope

**In:** the encode half. Enrol, poll, probe ffmpeg, run ffmpeg tasks, report progress and logs, honour cancel.

**Out of v1:** drives, `makemkvcon`, virtual drives, and the scan-output capture path. Also out: Windows,
macOS and FreeBSD builds.

The Node agent is **not touched**. It keeps doing everything, including the parts v1 omits. The Rust agent is
an additional, opt-in download. Dropping the Node agent is a separate decision for later, once this one has
run on real hardware for a while.

### Why encode-only is safe rather than half-finished

The server already refuses to give an agent work it cannot do. From `server/src/agents/registry.ts`:

```ts
function suits(a: Agent, t: AgentTask): boolean {
  if ((t.kind === 'rip' || t.kind === 'scan') && !a.capabilities.rip) return false;
  if (t.kind === 'transcode' && !a.capabilities.transcode) return false;
  ...
}
```

An agent reporting `rip: false, transcode: true` can only ever be handed `transcode` tasks. The encode-only
agent is not a subset that might be asked to do more than it can — it is a shape the server already
understands. `capture` is only ever set on scan tasks, so the stdout-capture path cannot be reached either.

## Keeping in step with the TypeScript contract

This is the part that needs deciding properly, because it is where a second language introduces the failure
mode that has already cost this project four fixes: notification events written out three times, `crop`
dropped from the profile schema, `groupBoxSets` and `fileMetadata` dropped from the settings schema. In every
case one description of a shape drifted from another and nothing said so.

**Decision: hand-written serde structs, with golden JSON fixtures checked by both sides.**

- `contract/agent-enrol.json` and `contract/agent-poll.json` hold a representative body each.
- A Rust test serialises its structs and asserts the result matches the fixture.
- A Node test feeds the same files to the existing `enrolSchema` and `pollSchema` from
  `server/src/routes/agents.ts` and asserts they parse.

Either side drifting fails CI, and the fixtures double as documentation of the protocol. The cost is two small
tests.

Rejected:

- **Generating Rust from the zod schemas** (JSON Schema → `typify`). Genuinely one source of truth, but it
  adds a build-toolchain chain for a 350-line program, and `driveSchema` is `z.object({}).passthrough()`,
  which generates badly.
- **Loose structs and no drift detection.** The protocol is tolerant today — zod strips unknown keys and most
  fields are optional — so this would work until the day a required field is added server-side, at which point
  the Rust agent fails at runtime with nothing in CI having objected.

## Design

### Layout

A standalone Cargo project at `agent-rs/`, outside `server/`, so neither `tsc` nor the npm workspaces see it.
Not a Cargo workspace — nothing else in the repo is Rust.

```
agent-rs/
  Cargo.toml
  src/
    main.rs        start-up, the enrol and poll loops
    cli.rs         flags and environment
    protocol.rs    serde structs for the wire
    ffmpeg.rs      capability probe
    runner.rs      spawn ffmpeg, parse -progress, cancel
    encoders.rs    generated: the encoder vocabulary
contract/
  agent-enrol.json
  agent-poll.json
```

### Command line

Flag-for-flag with the Node agent for everything that still applies, same environment variable names:

| Flag | Env | Default |
| --- | --- | --- |
| `--server <url>` | `REXARR_SERVER` | required |
| `--key <key>` | `REXARR_API_KEY` | required |
| `--name <name>` | `REXARR_AGENT_NAME` | hostname |
| `--config <dir>` | `REXARR_AGENT_CONFIG` | `~/.rexarr-agent` |
| `--ffmpeg <path>` | `REXARR_FFMPEG` | `ffmpeg` on PATH |
| `--concurrency <n>` | `REXARR_AGENT_CONCURRENCY` | 1 |

`--makemkv` and `--virtual-drives` are **accepted and ignored with a warning** rather than rejected, so a
systemd unit or compose file written for the Node agent does not fail to start after a swap. The warning says
this build does not do drives.

Same validation and the same wording as the Node agent: `--server` must be an http(s) URL, and a missing key
points at *Settings → General → Security*.

### Identity

The same `<config>/agent-id` file, same UUID v4 format, read if present and created if not. A machine swapped
from the Node agent to the Rust one therefore **rejoins as itself** — same row on the Agents page, same
approval, same path mappings — rather than appearing as a second agent needing approval again. This is worth
getting right; it is the difference between a swap being a non-event and being a support question.

### Capability probe

Mirrors `server/src/ffmpeg/capabilities.ts`:

- `ffmpeg -version` → first line, strip `ffmpeg version `, take the first word
- `ffmpeg -hide_banner -encoders` → names matched by `^[VASFXBD.]{6}\s+(\S+)`
- `ffmpeg -hide_banner -hwaccels` → lines after the first; optional, failure is not fatal

Each with a 10-second timeout. If ffmpeg is not found the agent prints why and exits 1 — with no MakeMKV in
this build there is nothing else it could do.

**`videoEncoders` is reported as the intersection of what ffmpeg has and the vocabulary Rexarr knows**, not the
raw list. Two reasons: the Agents page would otherwise show several hundred names, and `suits()` compares
`needsEncoders` against this list. That vocabulary lives in `VIDEO_ENCODER_INFO` in `shared/presets.ts`, so a
small script generates `agent-rs/src/encoders.rs` from it. The generated file is committed, and a test fails
when it no longer matches its source — the same rule as the contract fixtures.

### Reported capabilities

```
rip:              false
transcode:        true
ffmpegVersion:    from the probe
videoEncoders:    intersection, as above
hardware:         hwaccels joined with ", "
platform / arch:  Node's vocabulary - "linux", "x64" / "arm64"
cpus, totalMemoryBytes
```

`platform` and `arch` deserve care: Rust's natural answers are `x86_64` and `aarch64`, and sending those would
make Rust agents read differently from Node ones on the same page. Map them to Node's `process.platform` /
`process.arch` spelling.

### Enrol and poll

Unchanged from the Node agent, because the server is unchanged:

1. `POST /api/agents/enrol` with `{ id, name, version, capabilities, drives: [] }`, retrying every 10 s.
   A 401 and a 403 are reported as something to go and fix — wrong API key, rip farm mode off — rather than
   waited out silently.
2. Then `POST /api/agents/{id}/poll` every `pollSeconds` (server says 5) with what is running, each task's
   status, progress, and up to 100 buffered log lines. The answer carries `start`, `cancel`, `approved` and
   `pollSeconds`.
3. Finished tasks are reported once and then dropped.

Log lines are buffered to a cap of 500 per task and drained 100 at a time, as the Node agent does.

### Running ffmpeg

`-progress pipe:1`, read stdout line by line as `key=value`, mirroring `server/src/ffmpeg/runner.ts`:

- `frame`, `fps`, `bitrate`, `total_size`, `speed` are taken as they come
- `out_time_us` / `out_time_ms` are both microseconds in every released ffmpeg; divide by 1e6
- on `progress=`, compute `percent` from `outTimeSeconds / durationSeconds`, and `etaSeconds` from the parsed
  `speed` when it is positive, else from elapsed time against percent
- `progress=end` pins percent to 100

stderr is read line by line as the log. Cancel sends `SIGTERM`, then `SIGKILL` after 5 seconds.

**A task naming any program other than `ffmpeg` is refused** and reported as a failure with that reason. The
server is trusted to say what to encode, not to name a binary. This is the Node agent's rule and it carries
over unchanged.

### Error handling

A poll that fails is logged and retried after 10 s; the agent never exits on a network error, because the
machine it reports to is expected to reboot. An unparseable answer is treated the same way. The only paths
that exit are bad arguments (2) and no usable ffmpeg at start-up (1).

## Testing

**Rust unit tests**, which is most of the risk since the logic is parsing:

- argument and environment precedence, including the ignored-with-a-warning flags
- the `-progress` parser: percent, eta from speed, eta from elapsed when speed is absent, `progress=end`,
  partial lines split across reads
- encoder filtering against the generated vocabulary
- platform/arch mapping
- refusing a non-ffmpeg program

**Contract tests**, as described above: Rust serialises, Node's zod schemas parse, same fixtures.

**Generated-file freshness**: a test that regenerates `encoders.rs` and fails if it differs from what is
committed.

**On real hardware**, which is the only thing that actually settles it: rip-farm mode on, the Rust agent
enrolled against the live server, approved on the Agents page, and a real encode run to completion with
progress moving on the page — then a cancel mid-encode, and a restart to confirm it rejoins as the same agent
rather than a new one.

## CI and release

One job added to `.github/workflows/release.yml`:

| Runner | Target | Artifact |
| --- | --- | --- |
| `ubuntu-latest` | `x86_64-unknown-linux-musl` | `rexarr-agent-<version>-linux-x64` |
| `ubuntu-24.04-arm` | `aarch64-unknown-linux-musl` | `rexarr-agent-<version>-linux-arm64` |

Both build **natively** — the ARM runner is already in the matrix for the Node packages — so there is no cross
toolchain to maintain, only `musl-tools` and `rustup target add`. musl rather than glibc so the binary runs on
anything, including Alpine.

`cargo test` runs on pull requests alongside the existing checks.

The downloads table in the release notes gains a line for the agent, marked as Linux-only and optional.

## Open questions

None blocking. Two to revisit after it has run for a while:

1. Whether to port the drive half, which is where the real complexity is — MakeMKV robot mode, the shifting
   drive indices that have already caused bugs, virtual drives.
2. Whether to retire the Node agent. Not before the Rust one has done real work on real hardware, and not in
   the same release as anything else that matters.
