# Security Policy

## Supported Versions

Rexarr is in beta. Only the latest release receives security fixes.

| Version        | Supported          |
| -------------- | ------------------ |
| latest release | :white_check_mark: |
| older releases | :x:                |

## Reporting a Vulnerability

Please **do not** open a public issue for security problems.

Report them privately through GitHub:
[Security → Report a vulnerability](https://github.com/MoonlightLaboratory/rexarr/security/advisories/new).

Include what you found, how to reproduce it, the Rexarr version and how it is deployed. You'll get an
acknowledgement, and we'll keep you updated while a fix is prepared. Please give us reasonable time to release a
fix before disclosing the issue publicly.

## Things to know

- Rexarr can read, move and delete media files and talks to your \*arr apps with their API keys. Don't expose it
  to the internet without authentication (Settings → General → Security) and preferably a reverse proxy with HTTPS.
- API keys for Radarr, Sonarr, Lidarr, Prowlarr, slskd and TMDb are stored in the config folder
  (`<config>/data/settings.json`). Protect that folder and its backups.
