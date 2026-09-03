-- Reel4me — schema Supabase
-- A coller dans l'editeur SQL du projet (SQL Editor > New query > Run).
-- Idempotent : rejouable sans casse.

-- ---------------------------------------------------------------- items
-- Ce qui a ete ingere depuis HN / arXiv / RSS. L'id est un sha1 de l'URL
-- canonique, ce qui rend l'ingestion idempotente sans requete de controle.
create table if not exists items (
  id          text primary key,
  source      text not null,
  source_name text,
  url         text not null,
  title       text not null,
  summary     text,
  topic_hint  text,
  raw         jsonb,
  fetched_at  timestamptz not null default now(),
  processed   boolean not null default false
);

create index if not exists items_unprocessed_idx
  on items (fetched_at desc) where processed = false;

-- ---------------------------------------------------------------- cards
create table if not exists cards (
  id               text primary key,
  item_id          text references items(id) on delete set null,
  topic            text not null,
  title            text not null,
  body             text not null,
  takeaway         text,
  source_url       text,
  source_name      text,
  media_type       text not null default 'gradient',  -- photo | video | youtube | gradient
  media_fit        text not null default 'cover',     -- cover | contain
  media_url        text,
  media_poster     text,
  media_credit     text,
  media_credit_url text,
  served           integer not null default 0,
  kept             integer not null default 0,
  created_at       timestamptz not null default now()
);

-- Ajout retroactif : une base creee avant le mode harvest n'a pas media_fit.
alter table cards add column if not exists media_fit text not null default 'cover';

create index if not exists cards_feed_idx on cards (created_at desc);
create index if not exists cards_topic_idx on cards (topic, created_at desc);

-- --------------------------------------------------------- interactions
-- Ecrit par le telephone. C'est la boucle de retour : generate.mjs relit
-- cette table pour ponderer le lot du lendemain.
create table if not exists interactions (
  id         bigserial primary key,
  card_id    text references cards(id) on delete cascade,
  action     text not null check (action in ('seen','kept','skipped','opened','more','less')),
  dwell_ms   integer,
  created_at timestamptz not null default now()
);

create index if not exists interactions_recent_idx on interactions (created_at desc);
create index if not exists interactions_card_idx on interactions (card_id);

-- ------------------------------------------------------------------ RLS
-- La cle anon est embarquee dans la PWA, donc publique. Elle ne doit
-- pouvoir que LIRE les cartes et INSERER des interactions.
-- Les ecritures de cartes passent par la cle service_role, qui contourne
-- RLS et ne quitte jamais pipeline/.env sur le PC.

alter table items        enable row level security;
alter table cards        enable row level security;
alter table interactions enable row level security;

drop policy if exists "cards: lecture publique" on cards;
create policy "cards: lecture publique"
  on cards for select
  to anon, authenticated
  using (true);

drop policy if exists "interactions: insertion publique" on interactions;
create policy "interactions: insertion publique"
  on interactions for insert
  to anon, authenticated
  with check (true);

-- Aucune policy sur items : la table est donc invisible et inaccessible
-- avec la cle anon. C'est voulu, le front n'en a pas besoin.

-- ------------------------------------------------- compteurs de service
-- Incremente served/kept sans lecture prealable cote client.
create or replace function bump_card_stat(p_card_id text, p_field text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_field = 'served' then
    update cards set served = served + 1 where id = p_card_id;
  elsif p_field = 'kept' then
    update cards set kept = kept + 1 where id = p_card_id;
  end if;
end;
$$;

grant execute on function bump_card_stat(text, text) to anon, authenticated;
