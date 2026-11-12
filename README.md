# À l’affût

Les sorties rap FR, rap US et musique française de la semaine, et tout ce qui arrive bientôt.
Site : **https://zvxltt.github.io/a-l-affut/**

## Comment ça marche

Un robot (GitHub Actions, gratuit) prépare toutes les données **toutes les heures**, et toutes les 20 minutes dans la nuit du jeudi au vendredi, quand les sorties tombent. Le site n’a plus qu’à charger un seul fichier : il s’ouvre instantanément, et une page déjà ouverte se met à jour toute seule.

Le robot (`scripts/build-data.mjs`) :

1. suit environ 700 artistes : la liste de départ (`scripts/artists.txt`), plus les artistes « similaires » trouvés sur Deezer chaque semaine, plus les artistes cités dans les annonces Wikipédia ;
2. lit leur discographie Deezer pour repérer les sorties et les pré-sorties ;
3. récupère pour chaque sortie la tracklist, la durée de chaque titre, le label et les featurings exacts ;
4. cherche les sorties annoncées dans quatre autres sources : précommandes Apple Music, MusicBrainz, la section « Upcoming releases » des pages Wikipédia « 2026 in hip-hop » et « 2027 in hip-hop », et le fichier `data/annonces.json` ;
5. publie le tout sur GitHub Pages dans `data/releases.json` et `data/details.json`.

Chaque passage réutilise le résultat précédent : seules les nouveautés sont téléchargées.

## Le site

- **Cette semaine** : tout ce qui est sorti depuis vendredi, et les 8 semaines précédentes (flèches ou touches ← →).
- **À venir** : toutes les sorties annoncées, par mois et par date, avec leur source.
- **Fiche** au clic : pochette, durée, nombre de titres, label, featurings, tracklist avec la durée de chaque titre, extraits de 30 secondes, liens Deezer, Spotify, Apple Music et YouTube.
- Filtres Rap FR / Rap US / Musique FR et Albums / EP / Singles, recherche, pastille « Nouveau », thème clair et sombre.

Le site est en lecture seule : les visiteurs consultent, personne ne peut y ajouter de contenu.

## Modifier

- **Artistes suivis** : `scripts/artists.txt`, une ligne par artiste `identifiant_deezer|catégorie|fans|Nom` (catégories `rfr` rap FR, `rus` rap US, `mfr` musique FR, `fr` rap ou musique FR selon la sortie). L’identifiant est le nombre dans l’adresse deezer.com/artist/**5542343**.
- **Annonces relevées dans la presse** : `data/annonces.json`, au format `{"artist": "…", "title": "…", "date": "2026-12-04", "type": "album", "cat": "rfr", "source": "https://…"}`. Les dates passées sont ignorées toutes seules.
- **Forcer une mise à jour** : onglet Actions › « Mise à jour des sorties » › Run workflow.

## Logo

Le dossier `logo/` contient le logo noir et blanc en SVG et PNG : version noire, version blanche et icône seule.
