# À l’affût

Les sorties rap FR, rap US, musique française et des 150 artistes les plus écoutés en France : la semaine en cours et tout ce qui arrive bientôt.
Site : **https://zvxltt.github.io/a-l-affut/**

## Comment ça marche

Un robot (GitHub Actions, gratuit) prépare toutes les données **toutes les heures**, et toutes les 20 minutes dans la nuit du jeudi au vendredi, quand les sorties tombent. Le site n’a plus qu’à charger un seul fichier : il s’ouvre instantanément, et une page déjà ouverte se met à jour toute seule.

Le robot (`scripts/build-data.mjs`) :

1. suit plusieurs milliers d’artistes : la liste de départ (`scripts/artists.txt`), **les 150 artistes les plus écoutés en France** (classements Spotify France publiés par kworb.net, recalculés chaque jour : écoutes de la semaine + cumul depuis 2017), les artistes « similaires » sur Deezer, les catégories Wikipédia des rappeurs français, belges, suisses, québécois et américains et des chanteurs et chanteuses français, et les artistes cités dans les annonces de la presse (vérifiés sur Deezer) ;
   **le rap underground et la nouvelle scène** s’y ajoutent : les voisins Deezer du rap déjà suivi jusqu’à 1 500 fans, les artistes présents dans plusieurs playlists Deezer de rap underground, indé ou nouvelle scène (FR, BE, CH, QC, et US), les rappeurs des catégories Wikipédia à partir de 1 500 fans, et la liste `scripts/underground.txt` (un nom exact par ligne). Ces artistes n’apportent que leurs sorties rangées en rap, et un artiste qui s’avère ne pas faire de rap, ou rapper dans une autre langue, est écarté (revérifié tous les 30 jours). Le workflow « Essai de la découverte d’artistes », lancé à la main, montre ce qui serait ajouté sans rien publier ;
2. lit leur discographie Deezer pour repérer les sorties et les pré-sorties (les artistes actifs à chaque passage, les autres toutes les 6 ou 24 heures) ;
3. récupère pour chaque sortie la tracklist, la durée de chaque titre, le label et les featurings exacts ;
4. cherche les sorties annoncées : précommandes Apple Music, MusicBrainz, section « Upcoming releases » des pages Wikipédia « 20xx in hip-hop », fichier `data/annonces.json` ;
5. lit la presse (Google Actualités, les flux des médias rap, des recherches par date pour les dix prochains vendredis et par artiste à tour de rôle) pour repérer les annonces faites sur Instagram et reprises par les médias, du type « X annonce son album pour le 4 décembre » ; seul le sujet de la phrase est retenu (« Star Academy : Léa Doffey annonce… » concerne Léa Doffey ; dans « l’album Cocoon », Cocoon est un titre), les articles déjà repérés sont relus à chaque passage avec les règles du jour, et l’article est cité comme source ;
6. relève les concerts et festivals des artistes suivis en France, en Belgique et en Suisse : agendas Songkick de 32 grandes villes (données structurées, sans clé), toutes les 12 heures, chaque date rangée dans sa ville ou sa région (« Paris et Île-de-France », « Lyon »…) ; si une clé Ticketmaster est rangée dans le secret GitHub `TICKETMASTER_KEY`, ses dates (avec prix et lien direct) s’ajoutent ;
7. si une clé song.link (Odesli, gratuite sur demande à developers@song.link) est rangée dans le secret GitHub `ODESLI_KEY`, cherche le lien direct Spotify et YouTube des sorties récentes (25 par passage, gardés en cache) ; sans clé, ces boutons ouvrent une recherche ;
8. retire les doublons d’une même sortie (version « Clean », instrumentale, « Radio Edit », même projet listé deux fois) ;
9. publie le tout sur GitHub Pages dans `data/releases.json`, `data/details.json` et `data/concerts.json`.

Chaque passage réutilise le résultat précédent : seules les nouveautés sont téléchargées. GitHub ne lance pas toujours les passages programmés à l’heure (parfois seulement quelques-uns par jour) : chaque passage relance donc lui-même le suivant une heure après son départ, sauf si un autre est déjà en cours.

## Le site

- **À venir** (page d’accueil) : toutes les sorties annoncées, par mois et par date, avec leur source.
- **Cette semaine** : tout ce qui est sorti depuis vendredi, et les 8 semaines précédentes (flèches ou touches ← →). Les sorties les plus suivies d’abord (24 albums, 12 EP, 40 singles), le reste en un clic sur « Afficher les … autres » ; une recherche montre tout.
- **Concerts** : les dates à venir en France, Belgique et Suisse, par mois et par jour, avec la salle, l’heure, le prix de départ et le lien pour réserver ; filtres par genre, par pays et **par ville ou région**. Les concerts ne se chargent qu’à l’ouverture de l’onglet (le site démarre plus vite).
- **Abonnements** (onglet en haut à droite, comme sur Letterboxd ou Twitter) : le fil d’actualité des membres que l’on suit, du plus récent au plus ancien. Chaque post montre qui a noté quoi, la pochette, les étoiles et la critique (filtre « Critiques ») ; un clic ouvre la fiche. À côté : la recherche de membres par pseudo et des suggestions (ceux qui te suivent sans retour, les plus actifs de la semaine). Une pastille sur l’onglet compte les nouveautés depuis la dernière visite.
- **Fiche** au clic : pochette, liens d’écoute (Deezer, Spotify, Apple Music, YouTube ; lien direct quand il est connu, recherche sinon) juste sous le titre, bouton **« Suivre l’artiste »**, bouton **« Ajouter à l’agenda »** pour une sortie à venir (fichier .ics pour le calendrier du téléphone), durée, nombre de titres, label, featurings, notes, tracklist avec la durée de chaque titre et les extraits de 30 secondes, puis les critiques. Chaque fiche a sa propre adresse (`#semaine?fiche=…`) : le bouton « Partager » l’envoie ou la copie, et le bouton retour du téléphone ou du navigateur ferme la fiche.
- **Sur téléphone**, les cinq onglets (À venir, Semaine, Concerts, Abonnements, Profil) sont en bas de l’écran, à portée de pouce ; toucher l’onglet déjà ouvert remonte en haut. Chaque onglet retrouve sa position quand on y revient.
- **Recherche** : ce qui correspond dans les autres semaines ou dans « À venir » s’affiche sous les résultats (« Ailleurs sur le site »). Sur ordinateur, la touche `/` ouvre la recherche.
- Filtres Rap FR / Rap US / Musique FR / International et Albums / EP / Singles, recherche, pastille « Nouveau », thème clair et sombre. Les filtres actifs s’affichent en pastilles que l’on retire d’un toucher. **« Mes artistes »** ne montre que les sorties et concerts des artistes suivis (liste gardée sur l’appareil, modifiable dans Paramètres). « International » regroupe les artistes du top 150 France qui ne sont ni du rap FR, ni du rap US, ni de la musique française (The Weeknd, Bad Bunny, Tame Impala…), ainsi que la pop rangée jusque-là en rap US.
- **Notes et critiques** : chaque album, EP, compilation ou single se note de ½ à 5 étoiles, avec une critique écrite facultative, et **chaque son d’un projet se note aussi un par un**, directement dans la tracklist (les notes des sons s’enregistrent toutes seules). Tout cela **uniquement pendant la semaine de sortie** (du vendredi de la sortie au jeudi suivant, 23 h 59). Ensuite les notes sont figées : elles restent visibles, on peut seulement les supprimer. Le bouton « Partager » d’une note crée une image au format story (pochette, étoiles, critique) à envoyer ou enregistrer. La fiche affiche la moyenne, la répartition des notes, les critiques et la moyenne de chaque son ; « Cette semaine » affiche la moyenne sous chaque sortie notée et un classement « Les mieux notés » en deux onglets : albums et EP, et sons (titres notés un par un et singles).
- **Application** : le site s’installe sur l’écran d’accueil (« Ajouter à l’écran d’accueil ») avec sa propre icône et reste consultable hors connexion avec les dernières données chargées.
- **Paramètres** (roue en haut à droite) : thème automatique (suit l’appareil), clair ou sombre ; taille du texte ; animations réduites ; zoom autorisé ou non (bloqué par défaut) ; onglet d’ouverture ; pastilles « Nouveau » ; compte (profil, mot de passe, déconnexion, suppression) ; réinitialisation des réglages de l’appareil ; heure de la dernière mise à jour des données (« Mis à jour il y a X min », affichée seulement ici).
- **Abonnés et abonnements** : on s’abonne à un membre depuis son profil, le fil ou la recherche, sans demande à accepter (les notes sont publiques). Chaque profil affiche « N abonnés · N abonnements » ; un clic ouvre les listes (`#u/pseudo/abonnes`, `#u/pseudo/abonnements`), d’où l’on ouvre chaque profil ou s’abonne en retour. « Te suit » signale les membres qui te suivent ; chaque fiche affiche les notes de tes abonnements et met leurs critiques en tête.
- **Profil** (connexion avec Google, ou avec un e-mail et un mot de passe, « Mot de passe oublié » compris) : pseudo, nom, bio, **photo**, statistiques, **vitrine** de 4 sorties préférées, toutes ses notes, ses sons préférés et ses critiques. Chaque profil a une adresse publique `#u/pseudo` à partager. Le compte se modifie ou se supprime (avec toutes ses notes) depuis le profil. La photo de profil, entourée d’un fin cercle en haut à droite et dans la barre du bas, se change en touchant sa photo sur son profil ou dans « Modifier le profil » : choisir une image, la cadrer (glisser, zoom, pincer sur téléphone), la retirer ou reprendre sa photo Google.

## Comptes et notes

Les comptes et les notes sont gérés par Firebase (projet `a-l-affut`, offre gratuite Spark) : connexion Google, base Firestore en Europe. La configuration Firebase écrite dans `index.html` est publique par nature ; ce qui protège les données, ce sont les règles de `firebase/firestore.rules` :

- chacun ne peut écrire que ses propres notes, son profil et son pseudo (un pseudo ne peut appartenir qu’à une personne) ;
- une note n’est acceptée que pendant la semaine de sortie, entre 1 et 10 demi-étoiles, avec une critique de 3 000 caractères au plus ; les notes des sons sont rangées dans le même document que la note de la sortie (un caractère par titre, 150 titres au plus), si bien qu’une personne qui note tout un album ne coûte qu’une écriture et qu’une lecture ; passé ce délai, seuls le pseudo et le nom recopiés sur la note peuvent changer ;
- tout est lisible par tous, rien n’est modifiable par un autre compte ; les abonnements sont la liste `fr` du profil (300 au plus), les abonnés se retrouvent en cherchant les profils dont la liste contient le sien ;
- la photo de profil choisie est recadrée dans le navigateur (le plan gratuit n’a pas de stockage de fichiers) : une petite image de 96 px (moins de 9 000 caractères) dans le profil, recopiée sur chaque note, et une grande de 320 px dans `photos/{uid}`, lue seulement sur la page du profil ;
- le fil des abonnements lit les notes semaine par semaine (« membre parmi 30 » et « semaine = … »), ce qui ne demande aucun index à créer dans la console.

Le workflow « Tests des règles Firestore » vérifie ces règles sur l’émulateur Firebase à chaque modification du dossier `firebase/`. Pour changer les règles : modifier le fichier, puis le recopier dans la console Firebase › Firestore › Règles › Publier.

L’offre gratuite couvre 50 000 lectures et 20 000 écritures par jour ; au-delà, Firebase refuse les requêtes jusqu’au lendemain (rien n’est facturé sans passer à l’offre payante).

## Modifier

- **Artistes suivis** : `scripts/artists.txt`, une ligne par artiste `identifiant_deezer|catégorie|fans|Nom` (catégories `rfr` rap FR, `rus` rap US, `mfr` musique FR, `fr` rap ou musique FR selon la sortie, `int` international). L’identifiant est le nombre dans l’adresse deezer.com/artist/**5542343**.
- **Annonces relevées dans la presse** : `data/annonces.json`, au format `{"artist": "…", "title": "…", "date": "2026-12-04", "type": "album", "cat": "rfr", "source": "https://…"}`. Les dates passées sont ignorées toutes seules.
- **Forcer une mise à jour** : onglet Actions › « Mise à jour des sorties » › Run workflow.

## Logo

Le dossier `logo/` contient le logo noir et blanc en SVG et PNG : version noire, version blanche et icône seule.
