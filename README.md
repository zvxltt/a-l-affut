# À l’affût

Les sorties rap FR, rap US, musique française et des 150 artistes les plus écoutés en France : la semaine en cours et tout ce qui arrive bientôt.
Site : **https://zvxltt.github.io/a-l-affut/**

## Comment ça marche

Un robot (GitHub Actions, gratuit) prépare toutes les données **toutes les heures**, et toutes les 20 minutes dans la nuit du jeudi au vendredi, quand les sorties tombent. Le site n’a plus qu’à charger un seul fichier : il s’ouvre instantanément, et une page déjà ouverte se met à jour toute seule.

Le robot (`scripts/build-data.mjs`) :

1. suit plusieurs milliers d’artistes : la liste de départ (`scripts/artists.txt`), **les 150 artistes les plus écoutés en France** (classements Spotify France publiés par kworb.net, recalculés chaque jour : écoutes de la semaine + cumul depuis 2017), les artistes « similaires » sur Deezer, les catégories Wikipédia des rappeurs français, belges, suisses, québécois et américains et des chanteurs et chanteuses français, et les artistes cités dans les annonces de la presse (vérifiés sur Deezer) ;
2. lit leur discographie Deezer pour repérer les sorties et les pré-sorties (les artistes actifs à chaque passage, les autres toutes les 6 ou 24 heures) ;
3. récupère pour chaque sortie la tracklist, la durée de chaque titre, le label et les featurings exacts ;
4. cherche les sorties annoncées : précommandes Apple Music, MusicBrainz, section « Upcoming releases » des pages Wikipédia « 20xx in hip-hop », fichier `data/annonces.json` ;
5. lit la presse (Google Actualités, les flux des médias rap, des recherches par date pour les dix prochains vendredis et par artiste à tour de rôle) pour repérer les annonces faites sur Instagram et reprises par les médias, du type « X annonce son album pour le 4 décembre » ; seul le sujet de la phrase est retenu (« Star Academy : Léa Doffey annonce… » concerne Léa Doffey ; dans « l’album Cocoon », Cocoon est un titre), les articles déjà repérés sont relus à chaque passage avec les règles du jour, et l’article est cité comme source ;
6. relève les concerts et festivals des artistes suivis en France, en Belgique et en Suisse sur un an (API Discovery de Ticketmaster, toutes les 12 heures ; clé gratuite à ranger dans le secret GitHub `TICKETMASTER_KEY`) ;
7. publie le tout sur GitHub Pages dans `data/releases.json`, `data/details.json` et `data/concerts.json`.

Chaque passage réutilise le résultat précédent : seules les nouveautés sont téléchargées.

## Le site

- **À venir** (page d’accueil) : toutes les sorties annoncées, par mois et par date, avec leur source.
- **Cette semaine** : tout ce qui est sorti depuis vendredi, et les 8 semaines précédentes (flèches ou touches ← →).
- **Concerts** : les dates à venir en France, Belgique et Suisse, par mois et par jour, avec la salle, l’heure, le prix de départ et le lien pour réserver ; filtres par genre et par pays.
- **Fiche** au clic : pochette, durée, nombre de titres, label, featurings, tracklist avec la durée de chaque titre, extraits de 30 secondes, liens Deezer, Spotify, Apple Music et YouTube.
- Filtres Rap FR / Rap US / Musique FR / International et Albums / EP / Singles, recherche, pastille « Nouveau », thème clair et sombre. « International » regroupe les artistes du top 150 France qui ne sont ni du rap FR, ni du rap US, ni de la musique française (The Weeknd, Bad Bunny, Tame Impala…), ainsi que la pop rangée jusque-là en rap US.

Le site est en lecture seule : les visiteurs consultent, personne ne peut y ajouter de contenu.

## Modifier

- **Artistes suivis** : `scripts/artists.txt`, une ligne par artiste `identifiant_deezer|catégorie|fans|Nom` (catégories `rfr` rap FR, `rus` rap US, `mfr` musique FR, `fr` rap ou musique FR selon la sortie, `int` international). L’identifiant est le nombre dans l’adresse deezer.com/artist/**5542343**.
- **Annonces relevées dans la presse** : `data/annonces.json`, au format `{"artist": "…", "title": "…", "date": "2026-12-04", "type": "album", "cat": "rfr", "source": "https://…"}`. Les dates passées sont ignorées toutes seules.
- **Forcer une mise à jour** : onglet Actions › « Mise à jour des sorties » › Run workflow.

## Logo

Le dossier `logo/` contient le logo noir et blanc en SVG et PNG : version noire, version blanche et icône seule.
