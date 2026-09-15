import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Movie } from '@shared/types';
import { api, fmtAge, fmtBytes } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton, ToolbarSeparator } from '../components/Layout';
import { Icon } from '../components/Icons';
import { LoadingIndicator, QualityLabel } from '../components/Labels';
import { DetailHeader } from '../components/DetailHeader';
import { TranscodeModal, type TranscodeItem } from '../components/TranscodeModal';

const STATUS_CLASS: Record<string, string> = { waiting: 'blue', queued: '', probing: 'teal', encoding: 'remux', finalizing: 'teal', done: 'green', failed: 'red', cancelled: 'muted' };

let libraryCache: Movie[] | null = null;

export function MovieDetailPage() {
  const { id } = useParams();
  const movieId = Number(id);
  const { jobs } = useApp();
  const nav = useNavigate();
  const [movie, setMovie] = useState<Movie | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<TranscodeItem[] | null>(null);

  const load = () => {
    setError(null);
    setBusy(true);
    api.movie(movieId)
      .then(setMovie)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(load, [movieId]);

  const related = useMemo(() => jobs.filter((j) => j.source.arr === 'radarr' && j.source.arrId === movieId), [jobs, movieId]);

  const [all, setAll] = useState<Movie[] | null>(libraryCache);
  useEffect(() => {
    if (libraryCache) return;
    api.movies()
      .then((l) => {
        libraryCache = l;
        setAll(l);
      })
      .catch(() => {});
  }, []);
  const neighbours = useMemo(() => {
    if (!all) return { prev: null, next: null };
    const idx = all.findIndex((m) => m.id === movieId);
    if (idx < 0) return { prev: null, next: null };
    const prev = all[(idx - 1 + all.length) % all.length];
    const next = all[(idx + 1) % all.length];
    return { prev: prev && prev.id !== movieId ? { to: `/movies/${prev.id}`, title: prev.title } : null, next: next && next.id !== movieId ? { to: `/movies/${next.id}`, title: next.title } : null };
  }, [all, movieId]);
  const inQueue = related.some((j) => !['done', 'failed', 'cancelled'].includes(j.status));

  const item = (m: Movie): TranscodeItem => ({
    title: `${m.title} (${m.year})`,
    poster: m.poster,
    size: m.file?.size,
    quality: m.file?.quality,
    isRemux: m.file?.isRemux,
    source: { kind: 'movie', arr: 'radarr', arrId: m.id, fileId: m.file?.id, arrPath: m.file?.path, localPath: m.file?.localPath },
  });

  return (
    <Page
      title={movie ? movie.title : 'Movie'}
      flush
      toolbarLeft={
        <>
          <ToolbarButton icon={<Icon.ChevronRight />} label="Back" onClick={() => nav('/movies')} title="Back to movies" />
          <ToolbarSeparator />
          <ToolbarButton icon={<Icon.Refresh />} label="Refresh" onClick={load} busy={busy} />
          <ToolbarButton icon={<Icon.Search />} label="Search remux" wide to={`/search?kind=movie&id=${movieId}`} />
          <ToolbarSeparator />
          <ToolbarButton icon={<Icon.Play />} label={inQueue ? 'In queue' : 'Transcode'} wide disabled={!movie?.file || inQueue} selected={Boolean(movie?.file) && !inQueue} onClick={() => movie && setModal([item(movie)])} />
        </>
      }
    >
      {error && (
        <div className="error" style={{ margin: 20 }}>
          {error}
        </div>
      )}
      {!movie && !error && <LoadingIndicator>Loading movie…</LoadingIndicator>}
      {movie && (
        <>
          <DetailHeader
            backdrop={movie.fanart}
            poster={movie.poster}
            title={movie.title}
            year={movie.year}
            runtimeMinutes={movie.runtime}
            rating={movie.rating}
            genres={movie.genres}
            monitored={movie.monitored}
            overview={movie.overview}
            prev={neighbours.prev}
            next={neighbours.next}
            attribution="Metadata is provided by TMDb"
            badges={
              <>
                {movie.anime && <span className="badge purple" title={movie.titleKanji ?? ''}>Anime{movie.titleRomaji && movie.titleRomaji !== movie.title ? ` · ${movie.titleRomaji}` : ''}</span>}
                {movie.file ? <QualityLabel quality={movie.file.quality} isRemux={movie.file.isRemux} /> : <span className="badge red">No file</span>}
              </>
            }
            pills={[
              { icon: <Icon.Folder />, text: movie.path, title: 'Path' },
              ...(movie.file ? [{ icon: <Icon.HardDrive />, text: fmtBytes(movie.file.size), title: 'Size on disk' }] : []),
              ...(movie.qualityProfile ? [{ icon: <Icon.User />, text: movie.qualityProfile, title: 'Quality profile' }] : []),
              { icon: <Icon.Bookmark />, text: movie.monitored ? 'Monitored' : 'Unmonitored', title: 'Monitoring' },
              ...(movie.status ? [{ icon: <Icon.StopSquare />, text: movie.status[0].toUpperCase() + movie.status.slice(1), title: 'Status' }] : []),
              ...(movie.originalLanguage ? [{ icon: <Icon.Language />, text: movie.originalLanguage, title: 'Original language' }] : []),
              ...(movie.studio ? [{ icon: <Icon.Building />, text: movie.studio, title: 'Studio' }] : []),
              ...(movie.certification ? [{ icon: <Icon.Bookmark />, text: movie.certification, title: 'Certification' }] : []),
              { icon: <Icon.ExternalLink />, text: 'TMDb', href: `https://www.themoviedb.org/movie/${movie.tmdbId}`, title: 'Open on TMDb' },
              ...(movie.imdbId ? [{ icon: <Icon.ExternalLink />, text: 'IMDb', href: `https://www.imdb.com/title/${movie.imdbId}/`, title: 'Open on IMDb' }] : []),
              ...(movie.anidbId ? [{ icon: <Icon.ExternalLink />, text: 'AniDB', href: `https://anidb.net/anime/${movie.anidbId}`, title: 'Open on AniDB' }] : []),
            ]}
          />
          <div style={{ padding: 20 }}>
            <div className="grid-2">
              <div className="card">
                <div className="card-h">
                  <Icon.Film /> File
                  <span className="spacer" />
                  {movie.file && (
                    <button className="btn sm primary" disabled={inQueue} onClick={() => setModal([item(movie)])}>
                      <Icon.Play /> Transcode
                    </button>
                  )}
                </div>
                {movie.file ? (
                  <div className="card-b">
                    <div className="field row"><label>Quality</label><span><QualityLabel quality={movie.file.quality} isRemux={movie.file.isRemux} /></span></div>
                    <div className="field row"><label>Video</label><span>{movie.file.videoCodec ?? '—'}{movie.file.resolution ? ` · ${movie.file.resolution}` : ''}</span></div>
                    <div className="field row"><label>Audio</label><span>{movie.file.audioCodec ?? '—'}{movie.file.audioChannels ? ` · ${movie.file.audioChannels} channels` : ''}</span></div>
                    <div className="field row"><label>Languages</label><span>{movie.file.languages?.join(', ') || '—'}</span></div>
                    <div className="field row"><label>Size</label><span>{fmtBytes(movie.file.size)}</span></div>
                    <div className="field row"><label>Path</label><code className="small" style={{ wordBreak: 'break-all' }}>{movie.file.path}</code></div>
                    {movie.file.localPath !== movie.file.path && (
                      <div className="field row"><label>Local path</label><code className="small" style={{ wordBreak: 'break-all' }}>{movie.file.localPath}</code></div>
                    )}
                  </div>
                ) : (
                  <div className="empty">
                    <h3>No file yet</h3>
                    <p>
                      <Link to={`/search?kind=movie&id=${movieId}`}>Search for a Blu-ray remux</Link> and rexarr will encode it once Radarr imports the download.
                    </p>
                  </div>
                )}
              </div>
              <div className="card">
                <div className="card-h">
                  <Icon.Activity /> Encodes
                </div>
                {related.length === 0 && <div className="empty">No encodes for this movie yet.</div>}
                {related.map((j) => (
                  <div key={j.id} className="list-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="inline" style={{ gap: 6 }}>
                        <span className={`badge ${STATUS_CLASS[j.status] ?? ''}`}>{j.status}</span>
                        <span>{j.profileName}</span>
                        <span className="small muted">{fmtAge(j.finishedAt ?? j.startedAt ?? j.createdAt)}</span>
                      </div>
                      <div className="small muted truncate" title={j.outputPath ?? j.source.releaseTitle}>
                        {j.outputPath ?? j.source.releaseTitle ?? ''}
                      </div>
                      {['probing', 'encoding', 'finalizing'].includes(j.status) && (
                        <div className="progress md" style={{ marginTop: 6 }}>
                          <div style={{ width: `${j.progress.percent}%` }} />
                          <span className="text">{j.progress.percent.toFixed(0)}%</span>
                        </div>
                      )}
                    </div>
                    {j.status === 'done' && j.inputSizeBytes && j.outputSizeBytes ? (
                      <span className="small dim">
                        {fmtBytes(j.inputSizeBytes)} → {fmtBytes(j.outputSizeBytes)} ({((j.outputSizeBytes / j.inputSizeBytes) * 100).toFixed(0)}%)
                      </span>
                    ) : null}
                    <Link className="iconButton" to="/activity" title="Open activity">
                      <Icon.ChevronRight />
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
      {modal && <TranscodeModal items={modal} mediaType={movie?.anime ? 'anime' : 'movie'} onClose={() => setModal(null)} />}
    </Page>
  );
}
