import { useEffect, useRef, useState } from 'react';
import type { Card, Action } from '../lib/types';
import { TOPIC_LABEL } from '../lib/types';
import { gradientFor, TOPIC_ACCENT } from '../lib/gradient';

interface Props {
  card: Card;
  active: boolean;
  /** Assez proche de l'ecran pour valoir le telechargement de son media. */
  near: boolean;
  onAction: (action: Action) => void;
}

export default function CardView({ card, active, near, onAction }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [kept, setKept] = useState(false);
  const [vote, setVote] = useState<'more' | 'less' | null>(null);
  const [playingYouTube, setPlayingYouTube] = useState(false);

  // Le media distant peut avoir disparu (og:image d'un article edite, photo
  // supprimee). Sans ce repli, la carte afficherait un cadre casse.
  const [mediaFailed, setMediaFailed] = useState(false);

  // Une seule video joue a la fois : sur mobile, plusieurs lectures
  // simultanees vident la batterie et saturent le reseau.
  useEffect(() => {
    if (!active) setPlayingYouTube(false);

    const video = videoRef.current;
    if (!video) return;

    if (active) {
      video.play().catch(() => {
        // Lecture refusee par le navigateur : le poster reste affiche.
      });
    } else {
      video.pause();
      video.currentTime = 0;
    }
  }, [active, near]);

  const accent = TOPIC_ACCENT[card.topic] ?? '#8b9dff';
  const showMedia = near && card.media_url && !mediaFailed;
  const contain = card.media_fit === 'contain';

  const act = (action: Action) => {
    onAction(action);
    if (action === 'kept') setKept(true);
    if (action === 'more' || action === 'less') setVote(action);
  };

  const renderMedia = () => {
    if (!showMedia) return null;

    if (card.media_type === 'youtube') {
      // Tant que la carte n'est pas touchee, on n'affiche que la vignette :
      // charger un iframe YouTube par carte ruinerait le scroll.
      if (playingYouTube && active) {
        return (
          <iframe
            className="card__media"
            src={`https://www.youtube-nocookie.com/embed/${card.media_url}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            title={card.title}
          />
        );
      }
      return (
        <>
          {card.media_poster && (
            <img
              className="card__media"
              src={card.media_poster}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setMediaFailed(true)}
            />
          )}
          <button className="yt-play" onClick={() => setPlayingYouTube(true)} aria-label="Lire la vidéo">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        </>
      );
    }

    if (card.media_type === 'video') {
      return (
        <video
          ref={videoRef}
          className="card__media"
          src={card.media_url!}
          poster={card.media_poster ?? undefined}
          muted
          loop
          playsInline
          preload="none"
          onError={() => setMediaFailed(true)}
        />
      );
    }

    return (
      <>
        {/* Image large : une copie floutee et recadree bouche les bandes
            noires que "contain" laisserait sur les cotes. */}
        {contain && (
          <div className="card__backdrop" style={{ backgroundImage: `url("${card.media_url}")` }} />
        )}
        <img
          className={`card__media ${contain ? 'card__media--contain' : 'card__media--pan'}`}
          src={card.media_url!}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setMediaFailed(true)}
        />
      </>
    );
  };

  return (
    <article className="card" style={{ background: gradientFor(card.id, card.topic) }}>
      {renderMedia()}

      <div className="card__scrim" />

      <header className="card__top">
        <span className="chip" style={{ borderColor: accent, color: accent }}>
          {TOPIC_LABEL[card.topic] ?? card.topic}
        </span>
        {card.source_name && <span className="card__source">{card.source_name}</span>}
      </header>

      <div className="card__rail">
        <button
          className={`rail-btn ${kept ? 'is-on' : ''}`}
          onClick={() => act('kept')}
          aria-label="Garder cette carte"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z" />
          </svg>
        </button>
        <button
          className={`rail-btn ${vote === 'more' ? 'is-on' : ''}`}
          onClick={() => act('more')}
          aria-label="Plus de sujets comme celui-ci"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button
          className={`rail-btn ${vote === 'less' ? 'is-on' : ''}`}
          onClick={() => act('less')}
          aria-label="Moins de sujets comme celui-ci"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>

      <div className="card__body">
        <h2 className="card__title">{card.title}</h2>
        <p className="card__text">{card.body}</p>

        {card.takeaway && (
          <p className="card__takeaway" style={{ borderColor: accent }}>
            {card.takeaway}
          </p>
        )}

        <div className="card__footer">
          {card.source_url && (
            <a
              className="card__link"
              href={card.source_url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => act('opened')}
            >
              Lire la source
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 17 17 7M9 7h8v8" />
              </svg>
            </a>
          )}
          {/* Attribution exigee par les conditions de l'API Pexels. */}
          {card.media_credit && (
            <a
              className="card__credit"
              href={card.media_credit_url ?? 'https://www.pexels.com'}
              target="_blank"
              rel="noreferrer noopener"
            >
              {card.media_credit}
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
