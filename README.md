# Reel4me

Un feed de cartes de savoir qui se scrolle au téléphone, sur tes sujets (IA, dev, business, productivité), à **0 €/mois**.

Chaque nuit, le PC ingère de vraies sources, Claude les réécrit en cartes courtes et sourcées, et publie dans Supabase. Le téléphone lit le feed et renvoie tes likes, qui orientent le lot du lendemain.

```
Nuit (PC)      ingest ──► generate ──► media ──► publish
               HN/arXiv    claude -p    Pexels    Supabase
                 /RSS

Journée (tél.) PWA ◄── cards          interactions ──► Supabase
                                            │
Nuit suivante  generate relit les interactions ◄┘
```

## Pourquoi c'est gratuit

| Poste | Choix | Coût |
|---|---|---|
| Génération | `claude -p` sur ton abonnement Claude Max | 0 € |
| Base | Supabase, palier gratuit | 0 € |
| Visuels | API Pexels (200 req/h) | 0 € |
| Hébergement | Cloudflare Pages / Vercel | 0 € |

Le point clé : **`claude -p` sans `--bare`** lit les identifiants OAuth et consomme ton abonnement, pas des crédits API. Le mode `--bare` ferait l'inverse — il ignore l'OAuth et exige `ANTHROPIC_API_KEY`. `llm.js` ne l'utilise jamais.

## Installation

### 1. Claude Code en CLI

```bash
npm i -g @anthropic-ai/claude-code
claude          # une fois, en interactif, pour valider le login
```

### 2. Supabase

Créer un projet gratuit, puis coller `supabase/schema.sql` dans **SQL Editor → New query → Run**.

Récupérer dans **Project Settings → API** : l'URL, la clé `anon`, la clé `service_role`.

> **Les deux clés ne vont pas au même endroit.** `service_role` contourne RLS et écrit les cartes : elle reste dans `pipeline/.env`, sur le PC. `anon` part dans le bundle de la PWA, donc elle est publique — RLS la limite à *lire* `cards` et *insérer* dans `interactions`. Inverser les deux rendrait la base éditable par n'importe qui.

### 3. Pipeline

```bash
cd pipeline
npm install
cp .env.example .env        # puis remplir
```

Clé Pexels gratuite sur <https://www.pexels.com/api/>. Sans elle le pipeline tourne quand même : les cartes prennent un dégradé généré.

### 4. Application

```bash
cd app
npm install
cp .env.example .env.local  # URL + clé anon
node scripts/make-icons.mjs # icônes PWA (déjà générées, à relancer si tu changes le visuel)
npm run dev -- --host
```

Ouvrir l'IP LAN affichée depuis le téléphone, puis « Ajouter à l'écran d'accueil ».

### 5. Planification

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-task.ps1
```

Tâche quotidienne à 4h, avec rattrapage si le PC était éteint et sortie de veille. Elle tourne **sous ta session** : c'est obligatoire, les identifiants OAuth ne sont pas lisibles depuis un compte de service.

## Utilisation

```bash
node pipeline/run.mjs                        # le pipeline complet
node pipeline/ingest.mjs --dry               # ce qui serait ingéré
node pipeline/generate.mjs --sample --dry    # 3 cartes de test, sans Supabase
node pipeline/generate.mjs --limit 20        # limiter le lot
schtasks /run /tn Reel4me                    # déclencher la tâche à la main
```

Logs dans `pipeline/logs/`, un fichier par jour.

## Ce qui rend le feed intelligent

`generate.mjs` relit les 14 derniers jours d'`interactions` avant chaque lot et en tire trois signaux injectés dans le prompt : le taux de rétention par sujet, les mots-clés des cartes gardées, ceux des cartes systématiquement passées. En dessous de 15 interactions il ne pondère pas — mieux vaut couvrir large que sur-apprendre sur trois clics.

Les 60 derniers titres publiés partent aussi dans le prompt, en anti-répétition. Deuxième garde-fou : l'id d'une carte est un `sha1(item_id + titre)`, donc un doublon exact ne peut pas être inséré deux fois.

## Réglages utiles

| Fichier | Quoi |
|---|---|
| `pipeline/sources.json` | Ajouter/retirer des flux RSS, catégories arXiv, requêtes HN |
| `pipeline/generate.mjs` | `SYSTEM_PROMPT` — la ligne éditoriale, c'est là que se joue la qualité |
| `pipeline/schema.json` | La forme d'une carte |
| `pipeline/.env` | `CLAUDE_MODEL` (défaut `sonnet`), `LLM_BACKEND` |

## Si le PC ne peut plus tourner la nuit

Basculer sur l'API dans `pipeline/.env` :

```
LLM_BACKEND=api
ANTHROPIC_API_KEY=sk-ant-...
```

puis `npm i @anthropic-ai/sdk` dans `pipeline/`. Le modèle par défaut devient `claude-haiku-4-5`, soit environ 2 €/mois pour 60 cartes par jour. Le reste du pipeline ne change pas — `llm.js` expose la même fonction dans les deux cas.

## Licence et attributions

Projet personnel. Les visuels viennent de [Pexels](https://www.pexels.com) et l'attribution du photographe est affichée sur chaque carte, comme leurs conditions l'exigent.
