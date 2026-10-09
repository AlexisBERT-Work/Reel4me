# Reel4me

Un feed de cartes de savoir qui se scrolle au téléphone, sur tes sujets (IA, dev, business, productivité), à **0 €/mois**.

**→ [alexisbert-work.github.io/Reel4me](https://alexisbert-work.github.io/Reel4me/)**

Le pipeline, lancé en local, ingère de vraies sources, Claude les réécrit en cartes courtes et sourcées, et publie dans Supabase. Le téléphone lit le feed et renvoie tes likes, qui orientent le lot suivant.

```
Pipeline (local) ingest ──► generate ──► media ──────────► publish
                 HN/arXiv    claude -p    youtube/og:image  Supabase
                   /RSS      (sonnet)     /Pexels/dégradé

Burn (local)     harvest ─── Opus + WebSearch ──► media ──► publish

Journée (tél.)   PWA ◄── cards            interactions ──► Supabase
                                                 │
Lot suivant      generate relit les interactions ◄┘
```

## Pourquoi c'est gratuit

| Poste | Choix | Coût |
|---|---|---|
| Génération | Claude Code sur ton abonnement, via `CLAUDE_CODE_OAUTH_TOKEN` | 0 € |
| Exécution | En local | 0 € |
| Base | Supabase, palier gratuit | 0 € |
| Visuels | og:image des articles + API Pexels | 0 € |
| Hébergement | GitHub Pages | 0 € |

Deux points qui font tenir l'ensemble :

- **`claude -p` sans `--bare`** lit les identifiants OAuth et consomme ton abonnement, pas des crédits API. Le mode `--bare` ferait l'inverse : il ignore l'OAuth et exige `ANTHROPIC_API_KEY`. [llm.js](pipeline/llm.js) ne l'utilise jamais.

## Installation

### 1. Supabase

Créer un projet gratuit, puis coller [supabase/schema.sql](supabase/schema.sql) dans **SQL Editor → New query → Run**. Le script est rejouable sans casse.

Créer ensuite ton compte dans **Authentication → Users → Add user**, en cochant *Auto Confirm User*, puis te désigner comme propriétaire :

```sql
insert into app_owner (user_id)
select id from auth.users where email = 'ton@email'
on conflict do nothing;
```

Récupérer dans **Project Settings → API** : l'URL, la clé `anon`, la clé `service_role`.

> **Les deux clés ne vont pas au même endroit.** `service_role` contourne RLS et écrit les cartes : elle ne sort jamais de `pipeline/.env`. `anon` part dans le bundle de la PWA, donc elle est **publique et lisible par n'importe qui** — c'est pour ça qu'elle ne donne aucun accès à elle seule.

### 2. Token d'abonnement

```bash
npm i -g @anthropic-ai/claude-code
claude setup-token          # génère un token longue durée
```

### 3. Secrets GitHub

```bash
gh secret set VITE_SUPABASE_URL         # même URL
gh secret set VITE_SUPABASE_ANON_KEY    # clé anon, pas service_role
```

Puis relancer le déploiement pour que la PWA soit reconstruite avec les clés :

```bash
gh workflow run deploy.yml
```

## Utilisation

### Depuis le téléphone

Ouvrir l'URL, puis « Ajouter à l'écran d'accueil ». La PWA garde le feed en cache : le scroll continue en mode avion, les likes partent au retour du réseau.

### Le mode burn

Quand il te reste du quota d'abonnement, `harvest` lâche Opus sur le web avec `WebSearch` et `WebFetch`. Il ne réécrit pas des flux RSS : il **cherche**, ouvre les pages, vérifie, et écrit. Il tourne par salves, chacune sur un angle différent (papers, post-mortems, chiffres contre-intuitifs, anti-patterns…), et ne s'arrête que sur budget atteint, rounds épuisés, ou plafond de quota.

En local :

```bash
node pipeline/harvest.mjs                      # 20 salves, ~20 $ de quota
node pipeline/harvest.mjs --budget 5 --rounds 6
node pipeline/harvest.mjs --dry                # une salve, rien d'écrit
```

Le budget est une **jauge, pas une facture** : `total_cost_usd` est l'estimation client que renvoie la CLI, affichée même sous abonnement.

### En local

```bash
cd pipeline && npm install && cp .env.example .env   # puis remplir
node run.mjs                                  # le pipeline complet
node ingest.mjs --dry                         # ce qui serait ingéré
node generate.mjs --sample --dry              # 3 cartes de test, sans Supabase
```

```bash
cd app && npm install && cp .env.example .env.local
npm run dev -- --host                         # test sur le LAN
```

Logs dans `pipeline/logs/`, un fichier par jour.

## Sécurité

Le dépôt est public, le feed ne l'est pas.

**Les workflows.** Seul le déploiement de la PWA tourne sur GitHub Actions ; la génération et la récolte se lancent en local. Aucun workflow ne se déclenche sur `pull_request`, et GitHub retire de toute façon les secrets des runs venant d'un fork.

**La base.** La clé `anon` est dans le bundle, donc publique. Elle ne donne aucun accès seule : RLS réserve la lecture de `cards` et l'écriture d'`interactions` au compte inscrit dans `app_owner`.

L'accès est attaché à un **user id précis**, pas à « tout compte connecté ». La différence compte : si les inscriptions publiques restaient ouvertes côté Supabase, un `to authenticated` suffirait à laisser n'importe qui créer un compte et entrer. Ici le garde-fou ne dépend d'aucun réglage du tableau de bord. Désactiver les inscriptions publiques reste conseillé, en défense secondaire.

`bump_card_stat` est en `security definer`, donc contourne RLS : elle revérifie `is_owner()` en interne, sans quoi elle serait une porte dérobée pour gonfler les compteurs.

## Comment une carte trouve son image

Par ordre de préférence, du plus pertinent au plus générique :

1. **YouTube** — seulement en mode harvest, quand Opus est tombé sur une vidéo vraiment liée au sujet. L'identifiant est validé contre le format officiel : un id deviné donnerait une vidéo morte. Vignette d'abord, iframe au tap.
2. **Vidéo Pexels** — pour les cartes `hero` (1 sur 5 au plus), en boucle muette. Seule la carte visible joue.
3. **og:image de l'article** — l'image que le site publie pour être partagée. Souvent en 1200×630, donc affichée en entier sur une copie floutée d'elle-même plutôt que recadrée à l'aveugle.
4. **Photo Pexels** — verticale, avec un zoom lent façon Ken Burns.
5. **Dégradé généré** — déterministe à partir de l'id, donc stable d'une session à l'autre.

Si une image distante disparaît, la carte retombe sur son dégradé au lieu d'afficher un cadre cassé.

## Ce qui rend le feed intelligent

[generate.mjs](pipeline/generate.mjs) relit les 14 derniers jours d'`interactions` avant chaque lot et en tire trois signaux injectés dans le prompt : le taux de rétention par sujet, les mots-clés des cartes gardées, ceux des cartes systématiquement passées. En dessous de 15 interactions il ne pondère pas — mieux vaut couvrir large que sur-apprendre sur trois clics.

Les 60 derniers titres publiés partent aussi dans le prompt, en anti-répétition. Deuxième garde-fou : l'id d'une carte est un `sha1(source + titre)`, donc un doublon exact ne peut pas être inséré deux fois. En mode harvest, les 600 dernières URL publiées sont également exclues.

## Réglages

| Fichier | Quoi |
|---|---|
| [pipeline/sources.json](pipeline/sources.json) | Flux RSS, catégories arXiv, requêtes HN |
| [pipeline/generate.mjs](pipeline/generate.mjs) | `SYSTEM_PROMPT` — la ligne éditoriale, c'est là que se joue la qualité |
| [pipeline/harvest.mjs](pipeline/harvest.mjs) | `ANGLES` — les axes de recherche du mode burn |
| [pipeline/schema.json](pipeline/schema.json) | La forme d'une carte |

Le PC n'est plus nécessaire, mais [setup-task.ps1](setup-task.ps1) reste disponible si tu veux aussi une tâche Windows locale.

## Si tu préfères l'API au quota d'abonnement

Dans `pipeline/.env` :

```
LLM_BACKEND=api
ANTHROPIC_API_KEY=sk-ant-...
```

puis `npm i @anthropic-ai/sdk` dans `pipeline/`. Le modèle devient `claude-haiku-4-5`, soit environ 2 €/mois pour 60 cartes par jour. Le reste du pipeline ne change pas : `llm.js` expose la même fonction dans les deux cas.

## Attributions

Les visuels de repli viennent de [Pexels](https://www.pexels.com) et le crédit du photographe est affiché sur chaque carte concernée, comme leurs conditions l'exigent.
