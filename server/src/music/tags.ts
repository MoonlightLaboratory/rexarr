/**
 * The tags a ripped CD track carries. Field names follow Picard's Vorbis comment mapping, so Lidarr, Plex,
 * Navidrome and Picard itself all read back what MusicBrainz said about the disc.
 */
import type { CdInfo, MusicBrainzRelease, RipMedia } from '../../../shared/types.js';

/** MusicBrainz's "Various Artists" artist – a compilation, whatever the release is called. */
export const VARIOUS_ARTISTS = '89ad4ac3-39f7-470e-963a-56509c546377';

export type TagSet = Record<string, string | number | undefined>;

export function cdTrackTags(opts: { rel?: MusicBrainzRelease; cd?: CdInfo; media: RipMedia; track: number; trackTotal: number }): TagSet {
  const { rel, cd, media, track, trackTotal } = opts;
  const mt = rel?.tracks.find((x) => x.number === track);
  const various = rel?.artistId === VARIOUS_ARTISTS || /^various artists$/i.test(rel?.artist ?? '');
  // a CDDB entry knows nothing about MusicBrainz, so none of its ids are invented from it
  const mb = rel?.source === 'cddb' ? undefined : rel;
  return {
    TITLE: mt?.title ?? `Track ${track}`,
    ARTIST: mt?.artist ?? rel?.artist ?? media.artist,
    ARTISTSORT: mt?.artistSort ?? rel?.artistSort,
    ALBUMARTIST: rel?.artist ?? media.artist,
    ALBUMARTISTSORT: rel?.artistSort,
    ALBUM: rel?.title ?? media.title,
    TRACKNUMBER: track,
    TRACKTOTAL: rel?.trackCount || trackTotal,
    TOTALTRACKS: rel?.trackCount || trackTotal,
    DISCNUMBER: rel?.discNumber,
    DISCTOTAL: rel?.discCount,
    TOTALDISCS: rel?.discCount,
    DISCSUBTITLE: rel?.discTitle,
    // DATE is this pressing, ORIGINALDATE the album: a remaster keeps both, as Picard writes them
    DATE: rel?.date,
    ORIGINALDATE: rel?.originalDate,
    ORIGINALYEAR: rel?.originalDate?.slice(0, 4),
    LABEL: rel?.label,
    CATALOGNUMBER: rel?.catalogNumber,
    BARCODE: rel?.barcode,
    RELEASECOUNTRY: rel?.country,
    COMPILATION: various ? 1 : undefined,
    GENRE: rel?.genre,
    MEDIA: rel?.format || 'CD',
    // DISCID is what rippers have always written the freedb id as
    DISCID: rel?.cddbId,
    MUSICBRAINZ_ALBUMID: mb?.releaseId,
    MUSICBRAINZ_RELEASEGROUPID: mb?.releaseGroupId,
    MUSICBRAINZ_ALBUMARTISTID: mb?.artistId,
    MUSICBRAINZ_ARTISTID: mb && (mt?.artistId ?? mb.artistId),
    // Picard's convention: TRACKID is the recording, RELEASETRACKID the track on this release
    MUSICBRAINZ_TRACKID: mb && mt?.recordingId,
    MUSICBRAINZ_RELEASETRACKID: mb && mt?.trackId,
    MUSICBRAINZ_DISCID: cd?.discId,
    MQA: cd?.mqa?.detected ? 'MQA-CD' : undefined,
    ORIGINALSAMPLERATE: cd?.mqa?.detected ? cd.mqa.originalSampleRate : undefined,
  };
}
