import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import CardView from './components/CardView';
import Login from './components/Login';
import { configured, currentSession, fetchCards, onAuthChange, PAGE_SIZE, signOut } from './lib/supabase';
import { flush, loadSeen, record, saveSeen, watchConnectivity } from './lib/queue';
import type { Action, Card } from './lib/types';

/** En dessous, on considere que la carte a ete balayee sans etre lue. */
const DWELL_SEEN_MS = 3000;
/** Nombre de cartes restantes qui declenche le chargement de la page suivante. */
const PREFETCH_AT = 3;
/** Distance a la carte active en deca de laquelle on telecharge le media. */
const MEDIA_WINDOW = 2;

export default function App() {
  // undefined = on ne sait pas encore, null = deconnecte.
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [cards, setCards] = useState<Card[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  const cursor = useRef<string | undefined>(undefined);
  const seen = useRef<Set<string>>(new Set());
  const loading = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    seen.current = loadSeen();
    return watchConnectivity();
  }, []);

  useEffect(() => {
    if (!configured) {
      setSession(null);
      return;
    }
    void currentSession().then(setSession);
    return onAuthChange(setSession);
  }, []);

  const loadMore = useCallback(async () => {
    if (loading.current || exhausted) return;
    loading.current = true;

    try {
      // Les cartes deja vues sont filtrees cote client. Une page peut donc
      // revenir vide sans que le feed soit epuise : on insiste un peu.
      for (let attempt = 0; attempt < 4; attempt++) {
        const page = await fetchCards(cursor.current);
        if (page.length) cursor.current = page[page.length - 1].created_at;

        const fresh = page.filter((c) => !seen.current.has(c.id));
        if (fresh.length) {
          setCards((prev) => {
            const known = new Set(prev.map((c) => c.id));
            return [...prev, ...fresh.filter((c) => !known.has(c.id))];
          });
        }

        if (page.length < PAGE_SIZE) {
          setExhausted(true);
          break;
        }
        if (fresh.length) break;
      }

      setStatus((prev) => (prev === 'loading' ? 'ready' : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    } finally {
      loading.current = false;
    }
  }, [exhausted]);

  // Le premier chargement attend la session : sans jeton, RLS renvoie zero
  // carte et le feed s'afficherait vide a tort.
  useEffect(() => {
    if (!session) return;
    void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (status === 'ready' && !cards.length && exhausted) setStatus('empty');
  }, [status, cards.length, exhausted]);

  useEffect(() => {
    if (cards.length && cards.length - activeIndex <= PREFETCH_AT) void loadMore();
  }, [activeIndex, cards.length, loadMore]);

  // Mesure du temps passe sur la carte active. Le nettoyage de l'effet est
  // le seul endroit ou l'on connait la duree exacte.
  //
  // La dependance est l'id de la carte, pas le tableau `cards` : sinon chaque
  // page chargee en fond ferait tourner le nettoyage et enregistrerait un
  // faux "skipped" sur la carte en cours de lecture.
  const activeCardId = cards[activeIndex]?.id;

  useEffect(() => {
    if (!activeCardId) return;

    const start = Date.now();
    return () => {
      const dwell = Date.now() - start;
      const read = dwell >= DWELL_SEEN_MS;
      void record({ card_id: activeCardId, action: read ? 'seen' : 'skipped', dwell_ms: dwell });
      if (read) {
        seen.current.add(activeCardId);
        saveSeen(seen.current);
      }
    };
  }, [activeCardId]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // Le scroll-snap fait autorite : on lit l'index depuis la position plutot
  // que de piloter le scroll depuis React.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const index = Math.round(el.scrollTop / el.clientHeight);
    setActiveIndex((prev) => (prev === index ? prev : index));
  }, []);

  const onAction = useCallback((card: Card, action: Action) => {
    void record({ card_id: card.id, action, dwell_ms: null });
    if (action === 'kept' || action === 'less') {
      seen.current.add(card.id);
      saveSeen(seen.current);
    }
  }, []);

  if (!configured) {
    return (
      <div className="screen">
        <h1>Reel4me</h1>
        <p className="muted">
          Renseigne <code>VITE_SUPABASE_URL</code> et <code>VITE_SUPABASE_ANON_KEY</code> dans{' '}
          <code>app/.env.local</code>, puis relance le serveur.
        </p>
        <p className="muted">La clé anon, pas la clé service_role.</p>
      </div>
    );
  }

  if (session === undefined) {
    return (
      <div className="screen">
        <div className="spinner" />
      </div>
    );
  }

  if (session === null) return <Login />;

  if (status === 'loading') {
    return (
      <div className="screen">
        <div className="spinner" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="screen">
        <h1>Connexion impossible</h1>
        <p className="muted">{error}</p>
        <button
          className="btn"
          onClick={() => {
            setStatus('loading');
            setError(null);
            void loadMore();
          }}
        >
          Réessayer
        </button>
      </div>
    );
  }

  if (status === 'empty') {
    return (
      <div className="screen">
        <h1>Reel4me</h1>
        <p className="muted">Aucune carte pour l'instant.</p>
        <p className="muted">
          Lance le workflow <code>Pipeline nocturne</code> depuis l'onglet Actions pour remplir le feed.
        </p>
        <button className="link-btn" onClick={() => void signOut()}>
          Se déconnecter
        </button>
      </div>
    );
  }

  return (
    <div className="feed" ref={scroller} onScroll={onScroll}>
      {cards.map((card, index) => (
        <CardView
          key={card.id}
          card={card}
          active={index === activeIndex}
          near={Math.abs(index - activeIndex) <= MEDIA_WINDOW}
          onAction={(action) => onAction(card, action)}
        />
      ))}

      {exhausted && (
        <section className="card card--end">
          <div className="card__body">
            <h2 className="card__title">C'est tout pour aujourd'hui</h2>
            <p className="card__text">
              Le pipeline tourne chaque nuit. Pour un gros lot tout de suite, lance le workflow{' '}
              <code>Harvest</code> depuis l'onglet Actions.
            </p>
            <button className="link-btn" onClick={() => void signOut()}>
              Se déconnecter
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
