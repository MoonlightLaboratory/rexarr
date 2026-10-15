# The fingerprint

A disc has to be recognised before anything in RexDB is any use, and it has to be recognised from what a ripper
already has the moment it finishes scanning: no barcode, no user, no network. The fingerprint is that key.

Two implementations have to agree on it exactly or the database does not work, so this is the whole definition.

## How it is computed

```
label   = the volume label, uppercased, with every character that is not A-Z or 0-9 removed
track   = for each title, in the order the disc lists them: "<key>=<seconds>"
            key     the playlist file the title comes from ("00001.mpls"), lowercased;
                    where the disc gives none - a DVD, usually - the title's index as a decimal number
            seconds the title's duration, truncated to a whole number
payload = "rexdb1" + "\n" + label + "\n" + track[0] + "\n" + track[1] + ...
digest  = SHA-256 of payload, UTF-8
fingerprint = the first 16 characters of the digest, lowercase hex
```

`rexdb1` is the version. If this definition ever has to change, that string changes with it and old fingerprints
keep meaning what they meant.

### Worked example

A two-title Blu-ray labelled `SERIES_VOL_2`, playlists `00001.mpls` (1416 s) and `00002.mpls` (1418 s):

```
payload = "rexdb1\nSERIESVOL2\n00001.mpls=1416\n00002.mpls=1418"
fingerprint = "2dc06a4d8266f60a"
```

`scripts/fingerprint.mjs` computes it, and the checker uses the same function on every entry.

## Why the label is in it

Two pressings of the same season often have the same playlists and the same runtimes, and different episodes on
them. Including the label keeps a region A disc and a region B disc apart, which is the whole reason a
structure-only hash was not enough.

It costs something: a drive that reports the label differently produces a different fingerprint, and the disc is
missed. That is why entries also carry the structure in the open.

## When the hash misses

The fingerprint is an exact key, and discs are read by real drives, which disagree about durations by a second
now and then. So every entry also stores what went into it:

```json
"structure": {
  "titleCount": 2,
  "titles": [
    { "key": "00001.mpls", "seconds": 1416 },
    { "key": "00002.mpls", "seconds": 1418 }
  ]
}
```

A client that gets no hash match should look for an entry with the same title count whose durations are all
within a couple of seconds, and offer that as a suggestion rather than applying it. A near miss on the structure
is a strong hint; it is not the certainty an exact hash is.

## What is deliberately not in it

- **File sizes.** They vary between pressings of the same disc and between reads.
- **Chapter counts.** Rippers disagree about them.
- **The disc's own title names.** MakeMKV makes most of them up from the file name.
