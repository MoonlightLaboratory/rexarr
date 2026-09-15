import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icons';
import { Cover } from './Cover';

export interface Pill {
  icon: ReactNode;
  text: ReactNode;
  title?: string;
  href?: string;
}

/**
 * Sonarr-style details header: backdrop + dark overlay, poster, bookmark + big light title,
 * runtime / rating / genres / years line, a row of icon pills, the overview, prev/next arrows and
 * a metadata attribution in the corner.
 */
export function DetailHeader({ backdrop, poster, title, year, endYear, runtimeMinutes, rating, genres, pills, overview, prev, next, attribution, monitored, badges, square }: { backdrop?: string; poster?: string; title: string; year?: number; endYear?: number; runtimeMinutes?: number; rating?: number; genres: string[]; pills: Pill[]; overview: string; prev?: { to: string; title: string } | null; next?: { to: string; title: string } | null; attribution: string; monitored?: boolean; badges?: ReactNode; /** Music: square artist / album art. */ square?: boolean }) {
  const years = year ? (endYear && endYear !== year ? `${year}-${endYear}` : endYear ? `${year}-${endYear}` : String(year)) : '';
  return (
    <div className="detailHeader">
      <div className="backdrop" style={{ backgroundImage: backdrop ? `url(${backdrop})` : poster ? `url(${poster})` : undefined }} />
      <div className="backdropOverlay" />
      <div className="headerContent">
        <Cover className={`poster${square ? ' square' : ''}`} src={poster} maxAngle={10} scale={1.02} eager />
        <div className="headerInfo">
          <div className="titleRow">
            <div className="titleContainer">
              <span className="monitorIcon" title={monitored === false ? 'Unmonitored' : 'Monitored'} style={{ opacity: monitored === false ? 0.4 : 1 }}>
                <Icon.Bookmark />
              </span>
              <div className="title">{title}</div>
            </div>
            {(prev || next) && (
              <div className="navButtons">
                {prev && (
                  <Link to={prev.to} className="navButton" title={prev.title}>
                    <Icon.ArrowLeftCircle />
                  </Link>
                )}
                {next && (
                  <Link to={next.to} className="navButton" title={next.title}>
                    <Icon.ArrowRightCircle />
                  </Link>
                )}
              </div>
            )}
          </div>
          <div className="details">
            {runtimeMinutes ? <span>{runtimeMinutes} Minutes</span> : null}
            {rating !== undefined && rating > 0 ? (
              <span className="rating" title="Rating">
                <Icon.Heart /> {rating}%
              </span>
            ) : null}
            {genres.length > 0 && <span>{genres.join(', ')}</span>}
            {years && <span>{years}</span>}
            {badges}
          </div>
          <div className="pills">
            {pills.map((p, i) =>
              p.href ? (
                <a key={i} className="pill" href={p.href} target="_blank" rel="noreferrer" title={p.title}>
                  {p.icon}
                  <span>{p.text}</span>
                </a>
              ) : (
                <span key={i} className="pill" title={p.title}>
                  {p.icon}
                  <span>{p.text}</span>
                </span>
              ),
            )}
          </div>
          <div className="overview">{overview}</div>
        </div>
      </div>
      <div className="attribution">{attribution}</div>
    </div>
  );
}
