# CasaOS / ZimaOS app store submission

`Apps/Rexarr/` is the folder as the [CasaOS AppStore](https://github.com/IceWhaleTech/CasaOS-AppStore) wants it:
a compose file carrying the `x-casaos` metadata, the icons, three screenshots, a thumbnail and a changelog. The
asset URLs point at this repository through jsDelivr, so the store shows them without copying anything.

To submit or update the listing:

1. Fork `IceWhaleTech/CasaOS-AppStore`.
2. Copy `Apps/Rexarr` from here into `Apps/Rexarr` there.
3. Bump `x-casaos.version` and `update_at` to the release being listed, and add a line to `changelog.txt`.
4. Open a pull request against their `main`.

Their CI validates the compose and the metadata; a failing check usually means a missing `x-casaos` field or an
asset URL that does not resolve.

To install it on a box **without** the store listing, use
[`distribution/nas/zimaos/docker-compose.yml`](../nas/zimaos/docker-compose.yml) instead: same app, concrete paths,
no `$AppID` / `$PUID` variables for the store installer to fill in.
