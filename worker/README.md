# The submission service

Rexarr posts a disc here and this opens a pull request for it. It exists so that contributing needs nothing of
the contributor's — no GitHub account, no token in their Rexarr — and so that Rexarr never has to hold a
credential that could write to this repository. This holds one; nothing else does.

It decides nothing about what is true. Every submission becomes a **pull request**, the checker runs on it like
any other change, and a person still has to agree the episodes are right. A service that wrote straight to the
branch would be a service that could be made to write anything.

## What it checks before writing

- the shape of the entry, by the same rules `scripts/validate.mjs` enforces
- that every title value is one RexDB understands
- **that the fingerprint is really that disc's** — it is recomputed here, so a submission cannot claim to be a
  disc it is not, which is the one thing a wrong entry would need to do to be applied to someone else's rip
- that the entry is not implausibly large

A disc already in the branch, saying the same thing, is answered `already known` without opening anything.

## Deploying

```bash
cd worker
wrangler secret put GITHUB_TOKEN   # fine-grained, this repo only
wrangler deploy
```

The token wants **Contents: read and write** and **Pull requests: read and write**, on this repository and
nothing else. It opens pull requests against one branch and should not be able to do more than that.

Then point Rexarr at it: **Settings → Connections → RexDB → where contributions go**.

## Running it yourself

Nothing here is specific to this repository beyond `REPO` and `BRANCH` at the top of `index.js`. Change those,
deploy it somewhere of your own, and set the submission URL in Rexarr to match — a private database works the
same way as the public one.
