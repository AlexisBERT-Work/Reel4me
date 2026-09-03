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
-- La cle anon est embarquee dans la PWA, donc publique : n'importe qui peut
-- la lire dans le bundle. Elle ne doit donc RIEN pouvoir faire seule.
--
-- L'acces est reserve a un proprietaire nommement designe, pas a "tout
-- compte connecte" : sinon il suffirait que les inscriptions publiques
-- restent ouvertes cote Supabase pour que n'importe qui s'octroie l'acces.
-- Ce garde-fou ne depend d'aucun reglage du tableau de bord.
--
-- Les ecritures de cartes passent par la cle service_role, qui contourne
-- RLS et ne quitte jamais les secrets GitHub.

create table if not exists app_owner (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

alter table app_owner enable row level security;
-- Volontairement sans policy : la table est donc invisible depuis le front,
-- et seule la cle service_role peut la lire ou la modifier.

create or replace function is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from app_owner where user_id = auth.uid());
$$;

grant execute on function is_owner() to authenticated;

alter table items        enable row level security;
alter table cards        enable row level security;
alter table interactions enable row level security;

-- Les anciennes policies ouvertes sont retirees si elles existent.
drop policy if exists "cards: lecture publique" on cards;
drop policy if exists "interactions: insertion publique" on interactions;

drop policy if exists "cards: lecture proprietaire" on cards;
create policy "cards: lecture proprietaire"
  on cards for select
  to authenticated
  using (is_owner());

drop policy if exists "interactions: insertion proprietaire" on interactions;
create policy "interactions: insertion proprietaire"
  on interactions for insert
  to authenticated
  with check (is_owner());

-- Aucune policy sur items : la table est donc invisible et inaccessible
-- depuis le front. C'est voulu, il n'en a pas besoin.

-- ------------------------------------------------- compteurs de service
-- Incremente served/kept sans lecture prealable cote client.
create or replace function bump_card_stat(p_card_id text, p_field text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- security definer contourne RLS : sans ce controle, la fonction serait
  -- une porte derobee pour gonfler les compteurs sans etre proprietaire.
  if not is_owner() then
    raise exception 'non autorise';
  end if;

  if p_field = 'served' then
    update cards set served = served + 1 where id = p_card_id;
  elsif p_field = 'kept' then
    update cards set kept = kept + 1 where id = p_card_id;
  end if;
end;
$$;

revoke execute on function bump_card_stat(text, text) from anon;
grant execute on function bump_card_stat(text, text) to authenticated;

-- --------------------------------------------------------------- Rappel
-- Apres avoir cree ton utilisateur (Authentication > Users > Add user,
-- en cochant "Auto Confirm User"), designe-le comme proprietaire :
--
--   insert into app_owner (user_id)
--   select id from auth.users where email = 'ton@email'
--   on conflict do nothing;
--
-- Et par precaution, desactive les inscriptions publiques :
-- Authentication > Sign In / Providers > Email > "Allow new users to sign up".
