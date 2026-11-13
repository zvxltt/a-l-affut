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
6. relève les concerts et festivals des artistes suivis en France, en Belgique et en Suisse : agendas Songkick de 32 grandes villes (données structurées, sans clé), toutes les 12 heures ; si une clé Ticketmaster est rangée dans le secret GitHub `TICKETMASTER_KEY`, ses dates (avec prix et lien direct) s’ajoutent ;
7. retire les doublons d’une même sortie (version « Clean », instrumentale, « Radio Edit », même projet listé deux fois) ;
8. publie le tout sur GitHub Pages dans `data/releases.json`, `data/details.json` et `data/concerts.json`.

Chaque passage réutilise le résultat précédent : seules les nouveautés sont téléchargées.

## Le site

- **À venir** (page d’accueil) : toutes les sorties annoncées, par mois et par date, avec leur source.
- **Cette semaine** : tout ce qui est sorti depuis vendredi, et les 8 semaines précédentes (flèches ou touches ← →).
- **Concerts** : les dates à venir en France, Belgique et Suisse, par mois et par jour, avec la salle, l’heure, le prix de départ et le lien pour réserver ; filtres par genre et par pays.
- **Fiche** au clic : pochette, liens d’écoute (Deezer, Spotify, Apple Music, YouTube) juste sous le titre, durée, nombre de titres, label, featurings, notes, tracklist avec la durée de chaque titre et les extraits de 30 secondes, puis les critiques. Chaque fiche a sa propre adresse (`#semaine?fiche=…`) : le bouton « Partager » l’envoie ou la copie, et le bouton retour du téléphone ou du navigateur ferme la fiche.
- **Sur téléphone**, les quatre onglets (À venir, Semaine, Concerts, Profil) sont en bas de l’écran, à portée de pouce ; toucher l’onglet déjà ouvert remonte en haut. Chaque onglet retrouve sa position quand on y revient.
- **Recherche** : ce qui correspond dans les autres semaines ou dans « À venir » s’affiche sous les résultats (« Ailleurs sur le site »). Sur ordinateur, la touche `/` ouvre la recherche.
- Filtres Rap FR / Rap US / Musique FR / International et Albums / EP / Singles, recherche, pastille « Nouveau », thème clair et sombre. « International » regroupe les artistes du top 150 France qui ne sont ni du rap FR, ni du rap US, ni de la musique française (The Weeknd, Bad Bunny, Tame Impala…), ainsi que la pop rangée jusque-là en rap US.
- **Notes et critiques** : chaque album, EP, compilation ou single se note de ½ à 5 étoiles, avec une critique écrite facultative, et **chaque son d’un projet se note aussi un par un**, directement dans la tracklist (les notes des sons s’enregistrent toutes seules). Tout cela **uniquement pendant la semaine de sortie** (du vendredi de la sortie au jeudi suivant, 23 h 59). Ensuite les notes sont figées : elles restent visibles, on peut seulement les supprimer. La fiche affiche la moyenne, la répartition des notes, les critiques et la moyenne de chaque son ; « Cette semaine » affiche la moyenne sous chaque sortie notée et un classement « Les mieux notés » en deux onglets : albums et EP, et sons (titres notés un par un et singles).
- **Paramètres** (roue en haut à droite) : thème automatique (suit l’appareil), clair ou sombre ; taille du texte ; animations réduites ; zoom autorisé ou non (bloqué par défaut) ; onglet d’ouverture ; pastilles « Nouveau » ; compte (profil, mot de passe, déconnexion, suppression) ; réinitialisation des réglages de l’appareil.
- **Amis** : on ajoute quelqu’un en ami depuis son profil ou en cherchant son pseudo (sans demande à accepter : les notes sont publiques). Le profil montre l’activité des amis et la liste « Ils t’ont ajouté » ; chaque fiche affiche les notes des amis et met leurs critiques en tête.
- **Profil** (connexion avec Google, ou avec un e-mail et un mot de passe, « Mot de passe oublié » compris) : pseudo, nom, bio, statistiques, **vitrine** de 4 sorties préférées, toutes ses notes, ses sons préférés et ses critiques. Chaque profil a une adresse publique `#u/pseudo` à partager. Le compte se modifie ou se supprime (avec toutes ses notes) depuis le profil.

## Comptes et notes

Les comptes et les notes sont gérés par Firebase (projet `a-l-affut`, offre gratuite Spark) : connexion Google, base Firestore en Europe. La configuration Firebase écrite dans `index.html` est publique par nature ; ce qui protège les données, ce sont les règles de `firebase/firestore.rules` :

- chacun ne peut écrire que ses propres notes, son profil et son pseudo (un pseudo ne peut appartenir qu’à une personne) ;
- une note n’est acceptée que pendant la semaine de sortie, entre 1 et 10 demi-étoiles, avec une critique de 3 000 caractères au plus ; les notes des sons sont rangées dans le même document que la note de la sortie (un caractère par titre, 150 titres au plus), si bien qu’une personne qui note tout un album ne coûte qu’une écriture et qu’une lecture ; passé ce délai, seuls le pseudo et le nom recopiés sur la note peuvent changer ;
- tout est lisible par tous, rien n’est modifiable par un autre compte.

Le workflow « Tests des règles Firestore » vérifie ces règles sur l’émulateur Firebase à chaque modification du dossier `firebase/`. Pour changer les règles : modifier le fichier, puis le recopier dans la console Firebase › Firestore › Règles › Publier.

L’offre gratuite couvre 50 000 lectures et 20 000 écritures par jour ; au-delà, Firebase refuse les requêtes jusqu’au lendemain (rien n’est facturé sans passer à l’offre payante).

## Modifier

- **Artistes suivis** : `scripts/artists.txt`, une ligne par artiste `identifiant_deezer|catégorie|fans|Nom` (catégories `rfr` rap FR, `rus` rap US, `mfr` musique FR, `fr` rap ou musique FR selon la sortie, `int` international). L’identifiant est le nombre dans l’adresse deezer.com/artist/**5542343**.
- **Annonces relevées dans la presse** : `data/annonces.json`, au format `{"artist": "…", "title": "…", "date": "2026-12-04", "type": "album", "cat": "rfr", "source": "https://…"}`. Les dates passées sont ignorées toutes seules.
- **Forcer une mise à jour** : onglet Actions › « Mise à jour des sorties » › Run workflow.

## Logo

Le dossier `logo/` contient le logo noir et blanc en SVG et PNG : version noire, version blanche et icône seule.
