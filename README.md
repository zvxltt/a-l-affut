# À l’affût

Les sorties rap FR, rap US et musique française de la semaine, et tout ce qui arrive bientôt.
Le site se met à jour tout seul à chaque visite : aucune base de données, aucun serveur, aucune clé d’API.

## Ce que fait le site

- **Cette semaine** : tout ce qui est sorti depuis vendredi (albums, EP, singles), classé par popularité, avec les semaines précédentes accessibles par les flèches (ou les touches ← →).
- **À venir** : les projets annoncés, triés par date de sortie. Trois sources automatiques sont croisées : les pré-sorties Deezer, les précommandes Apple Music et la base MusicBrainz. On peut aussi ajouter une date à la main.
- **Fiche détaillée** au clic : pochette, date, durée, nombre de titres, label, featurings, tracklist avec la durée de chaque titre, extraits de 30 secondes, liens Deezer / Spotify / Apple Music / YouTube.
- **Ma liste** : les projets mis de côté pour plus tard.
- **Artistes** : environ 300 artistes suivis (rap FR, rap US, musique FR), plus les nouveaux noms du Top 100 France ajoutés automatiquement. On peut en ajouter ou en retirer.
- Pastille **Nouveau** sur ce qui est apparu depuis ta dernière visite, thème clair / sombre, version téléphone.

## Comment ça marche

À chaque visite, le navigateur interroge directement l’API publique de Deezer pour chaque artiste suivi (en JSONP, sans clé), puis Apple Music et MusicBrainz pour les annonces. Les résultats sont gardés quelques heures dans le navigateur : la première visite prend environ une minute, les suivantes sont instantanées. Le vendredi matin, la vérification est plus fréquente pour attraper les sorties de minuit.

## Mettre en ligne

Le site tient dans un seul fichier, `index.html`. Il suffit de le déposer sur n’importe quel hébergement statique :

- **GitHub Pages** : mets `index.html` dans un dépôt, puis Settings › Pages › Deploy from a branch › `main` / `(root)`.
- **Netlify Drop** : glisse le dossier sur app.netlify.com/drop.
- Ou ouvre simplement `index.html` dans ton navigateur.

Sur iPhone, « Partager › Sur l’écran d’accueil » l’installe comme une app avec son icône.

## Modifier la liste d’artistes par défaut

La liste est dans `index.html`, dans la constante `ARTISTS_RAW`, une ligne par artiste :

```
identifiant_deezer|catégorie|fans|Nom
```

Catégories : `rfr` (rap FR), `rus` (rap US), `mfr` (musique FR), `fr` (rap ou musique FR selon le genre de chaque sortie).
L’identifiant Deezer est le nombre dans l’adresse de la page de l’artiste (deezer.com/artist/**5542343**).

## Logo

Le dossier `logo/` contient le logo noir et blanc en SVG et PNG : version noire, version blanche et icône seule.
