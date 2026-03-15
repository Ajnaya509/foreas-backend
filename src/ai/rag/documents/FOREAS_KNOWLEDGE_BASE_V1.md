# FOREAS KNOWLEDGE BASE V1.0 — Base de Connaissances Ajnaya

> Document RAG principal. Découpé en morceaux par le retriever pgvector.
> Chaque section = 1 chunk indexé. Le retriever sélectionne les 3-5 chunks
> les plus pertinents par rapport à la question du chauffeur.
> Dernière mise à jour : Mars 2026

---

## SECTION 1 : ALGORITHME UBER — FONCTIONNEMENT INTERNE

### Comment Uber distribue les courses
L'algorithme Uber attribue les courses en utilisant un score composite qui combine la proximité géographique du chauffeur par rapport au client (facteur dominant, rayon de 800m), le taux d'acceptation du chauffeur (seuil critique à 85%), la note moyenne du chauffeur, et le statut Uber Pro (Blue, Gold, Platinum, Diamond). Un chauffeur Diamond avec un taux d'acceptation de 95% recevra systématiquement la course avant un chauffeur Blue à 80% même s'il est 200m plus loin.

### Taux d'acceptation Uber — Le piège
Refuser 3 courses consécutives sur Uber déclenche une pénalité silencieuse de 15 à 20 minutes où l'algorithme réduit la priorité du chauffeur. Cette pénalité n'est pas affichée dans l'app. Le taux d'acceptation est calculé sur les 10 dernières propositions. Un chauffeur qui accepte 8 courses sur 10 est à 80% et commence à perdre en priorité. Le seuil critique est 85% : en dessous, la fréquence des propositions chute de 20-30%.

### Surge Pricing Uber — Quand et pourquoi
Le surge (majoration tarifaire) se déclenche quand le ratio demande/chauffeurs disponibles dépasse 1.5x dans un rayon de 800m. Le surge monte par paliers : 1.2x, 1.5x, 1.8x, 2.0x et au-delà. Il est calculé zone par zone, pas uniformément sur toute la ville. Un surge à 1.8x à Bastille ne signifie pas qu'il y a du surge à Châtelet (2km plus loin). L'erreur classique : voir le surge monter et y aller. Le temps d'arriver (10-15 min), le surge est souvent redescendu car d'autres chauffeurs ont fait pareil. La stratégie gagnante : se positionner AVANT dans les zones où le surge va monter (sorties de concerts, fermetures de bars, fins de matchs).

### Uber Pro — Avantages concrets
Uber Pro est un programme de fidélité à 4 niveaux. Blue (par défaut, pas d'avantage notable). Gold (taux acceptation >85%, note >4.85, 200 points) : accès au temps et direction estimés de la course AVANT d'accepter. Platinum (400 points) : support prioritaire, remise essence Totalenergies. Diamond (600 points) : 3% de réduction essence BP, accès aux courses longues distance (+40km), priorité absolue dans l'algorithme. Le statut se recalcule tous les 3 mois.

### Commission Uber
Uber prélève une commission de 25% sur le montant de chaque course. Sur une course facturée 20€ au client, le chauffeur reçoit 15€. Cette commission est fixe et non négociable. Elle inclut l'assurance professionnelle pendant les courses. Uber a augmenté sa commission de 20% à 25% en 2023 pour la plupart des villes françaises.

---

## SECTION 2 : ALGORITHME BOLT — FONCTIONNEMENT INTERNE

### Comment Bolt distribue les courses
L'algorithme Bolt favorise les chauffeurs qui restent connectés longtemps sans interruption. Un chauffeur connecté depuis 3h continue sera priorisé par rapport à un chauffeur qui vient de se connecter, toutes choses égales par ailleurs. Bolt utilise aussi la proximité client mais avec un rayon plus large (1.2km vs 800m Uber). Bolt envoie des notifications "zone chaude" aux chauffeurs mais ces notifications sont décalées de 10 à 15 minutes par rapport à la réalité. Quand tu reçois "Zone chaude à Bastille", les chauffeurs proches sont déjà en train de prendre les courses.

### Commission Bolt — L'avantage compétitif
Bolt prélève 15% de commission contre 25% chez Uber. Sur une course à 20€, le chauffeur reçoit 17€ chez Bolt contre 15€ chez Uber. Soit 2€ de plus par course. Sur 20 courses par jour, c'est 40€ de différence. Sur un mois de 25 jours, c'est 1 000€ de plus par mois pour le même volume de courses. Cependant, Bolt a généralement moins de volume qu'Uber en Île-de-France. La stratégie optimale est d'utiliser les deux en parallèle.

### Bolt — Spécificités
Bolt a un système de bonus hebdomadaire : si le chauffeur complète X courses dans la semaine, il reçoit un bonus de Y euros. Ces bonus varient chaque semaine et sont personnalisés. Bolt propose aussi des courses "Bolt Business" (clients entreprise) qui sont généralement plus rentables car les trajets sont plus longs et les pourboires plus fréquents. Les courses Bolt Business sont reconnaissables par un badge bleu dans l'app.

---

## SECTION 3 : ALGORITHME HEETCH — FONCTIONNEMENT INTERNE

### Heetch — Le spécialiste soirée/nuit
Heetch est positionné sur le créneau 22h-6h avec une clientèle jeune (18-30 ans). Les courses sont généralement courtes (3-8km) mais l'enchaînement est rapide : un chauffeur actif peut enchaîner 4-5 courses par heure en zone nocturne. L'algorithme Heetch donne la priorité aux chauffeurs réguliers par rapport aux occasionnels. Un chauffeur qui se connecte chaque vendredi et samedi soir sera mieux positionné qu'un chauffeur qui apparaît aléatoirement.

### Commission Heetch
Heetch prélève entre 18% et 20% de commission selon les marchés. C'est un intermédiaire entre Uber (25%) et Bolt (15%). La clientèle Heetch donne rarement des pourboires mais le volume nocturne compense. Sur le créneau 23h-2h en zone Bastille/Oberkampf, un chauffeur Heetch peut réaliser 25-30€/h net.

---

## SECTION 4 : FREENOW — FONCTIONNEMENT

### FreeNow — Le premium business
FreeNow (ex-Kapten, ex-MyTaxi) cible une clientèle business/premium. Les courses sont plus longues (panier moyen 25-35€ vs 15-20€ chez Uber) et les pourboires sont fréquents (30-40% des courses). Le volume est plus faible qu'Uber/Bolt mais la rentabilité par course est supérieure. FreeNow est particulièrement actif dans les quartiers d'affaires (La Défense, 8ème, 16ème) et pour les transferts aéroport.

### Commission FreeNow
FreeNow prélève environ 18% de commission. Avec le panier moyen plus élevé et les pourboires, un chauffeur FreeNow peut atteindre 22-28€/h net sur les bons créneaux. La plateforme est moins saturée que Uber/Bolt, ce qui signifie moins de temps d'attente entre les courses.

---

## SECTION 5 : STRATÉGIE MULTI-APP — LE GAME CHANGER

### Pourquoi le multi-app est obligatoire
Un chauffeur qui n'utilise qu'Uber perd en moyenne 20-35% de revenus potentiels. La stratégie gagnante est d'allumer 2-3 apps simultanément (Uber + Bolt minimum), de prendre la première course qui tombe, et de couper les autres apps pendant la course. Cette méthode réduit le temps d'attente entre les courses de 8-12 min (mono-app) à 3-5 min (multi-app).

### Combinaisons optimales par créneau
Matin semaine (7h-10h) : Uber + FreeNow (business rush). Midi (12h-14h) : Uber + Bolt (volume max). Après-midi (14h-17h) : Bolt seul (commission basse, volume moyen). Soir semaine (17h-21h) : Uber + Bolt (rush retour). Nuit semaine (22h-2h) : Heetch + Bolt (soirée). Nuit week-end (22h-4h) : Heetch + Uber (surge + volume nocturne). Aéroport : Uber uniquement (file VTC dédiée, courses longues).

### Erreur #1 : rester sur une seule app
Beaucoup de chauffeurs restent fidèles à Uber par habitude. C'est une erreur qui coûte entre 500€ et 1 500€/mois de manque à gagner. Les plateformes ne récompensent PAS la fidélité exclusive. Uber Diamond ne compense pas la perte de revenus liée au temps mort entre les courses.

---

## SECTION 6 : ZONES PARIS — GUIDE STRATÉGIQUE PAR CRÉNEAU

### Rush matin (7h-10h) — Semaine uniquement
Les gares parisiennes sont les zones les plus rentables le matin en semaine. Gare du Nord reçoit les Thalys et Eurostar (passagers business, courses longues vers La Défense ou le 8ème). Gare de Lyon reçoit les TGV du sud (Lyon, Marseille, Nice). Gare Saint-Lazare reçoit les trains de banlieue ouest (volume élevé, courses courtes mais rapides). Positionnement optimal : se garer à 200-300m de la gare, PAS dans la file VTC. L'algorithme cherche le chauffeur le plus proche du CLIENT qui sort de la gare, pas celui dans le parking VTC.

### La Défense — Le quartier business
La Défense est rentable uniquement en semaine, aux heures de bureau. Le matin (8h-10h) : courses depuis les gares et les transports. Le midi (12h-14h) : déjeuners d'affaires, courses courtes. Le soir (17h-19h30) : retour domicile, courses longues vers l'ouest parisien (Neuilly, Boulogne, Versailles). Le week-end et après 20h, La Défense est morte. Zéro demande.

### Bastille — Le hub nocturne
Bastille est le carrefour nocturne numéro 1 de Paris. De 21h à 2h, la demande est forte et constante. Les bars de la rue de Lappe et de la rue de la Roquette se vident par vagues. Positionnement optimal : rue de la Roquette ou place de la Bastille côté Opéra. Attention : après 2h, la demande chute brutalement. Mieux vaut se décaler vers Oberkampf ou Pigalle.

### Oberkampf — La zone tendance
Oberkampf (rue Oberkampf, rue Jean-Pierre Timbaud) est la zone la plus rentable entre 23h et 3h le week-end. Clientèle jeune, courses courtes (vers le 11ème, 20ème, Belleville) mais enchaînement très rapide. Un chauffeur bien positionné peut faire 5-6 courses/heure ici. Meilleur positionnement : carrefour Oberkampf/Parmentier.

### Aéroports — Le calcul rentabilité
CDG (Roissy) : course vers Paris centre = 55-70€, durée 45-60min. Mais la file d'attente VTC = 30-50 min d'attente non payée. Rentable uniquement si le chauffeur y va AVEC une course aller (dépose un client). Un aller-retour CDG sans course aller = 2h pour 55€ = 27,50€/h brut = 20€/h net. Pas rentable. Orly : course vers Paris = 35-50€, file d'attente plus courte (15-25 min). Plus rentable que CDG pour les courses isolées. Stratégie aéroport : n'y aller que si c'est sur ta route. Jamais un aller à vide.

### Les pièges à éviter
Roissy CDG un vendredi après-midi : file d'attente 60+ min pour une course courte vers Villepinte ou Tremblay. La Défense un dimanche : zéro demande, perte de temps. Champs-Élysées après 3h du matin : que des touristes qui marchent, pas de course. Porte de Versailles hors salon : zone morte. Vérifier le calendrier des salons (Parc des Expositions).

---

## SECTION 7 : POSITIONNEMENT GPS — L'ASTUCE QUE 90% DES CHAUFFEURS IGNORENT

### Pourquoi se garer à 200-300m de la destination
Tous les algorithmes (Uber, Bolt, Heetch) cherchent le chauffeur le PLUS PROCHE du client au moment de la demande. Quand un client sort d'une gare, il lance sa course DEVANT la gare, pas dans le parking VTC. Les chauffeurs garés dans la file VTC officielle sont à 300-500m du client. Un chauffeur malin se gare dans une rue calme à 100-200m de la sortie principale. Il reçoit la course en premier. Cette stratégie fonctionne aussi devant les restaurants, hôtels, salles de concert.

### Le cercle d'exclusion Uber
Uber a un cercle d'exclusion autour des aéroports : seuls les chauffeurs dans la file VTC officielle peuvent recevoir des courses aéroport. Se garer en dehors de la zone aéroport = pas de course aéroport. Cette règle n'existe PAS pour les gares ou les lieux normaux.

---

## SECTION 8 : RÉGLEMENTATION VTC FRANCE 2026

### Statut juridique
Pour exercer en tant que chauffeur VTC en France, il faut : une carte professionnelle VTC délivrée par la préfecture (examen ou VAE), un véhicule de moins de 6 ans (7 ans pour les véhicules électriques ou hybrides), une assurance RC professionnelle, une inscription au registre VTC (géré par le ministère des Transports), un casier judiciaire vierge (bulletin n°2). Le non-respect de ces obligations = amende de 15 000€ et confiscation du véhicule.

### Différence VTC vs Taxi
Un VTC ne peut PAS prendre de clients dans la rue (maraude). Toute course doit être réservée à l'avance via une plateforme ou un appel direct. Un VTC ne peut PAS stationner sur les emplacements taxi. Un VTC peut fixer librement ses tarifs (contrairement aux taxis qui ont un compteur réglementé). Un VTC doit retourner à sa base (ou se déplacer) entre deux courses réservées.

### Obligations sociales
Un chauffeur VTC en auto-entrepreneur paie 24,6% de cotisations sociales sur son chiffre d'affaires brut (URSSAF). Il déclare son CA tous les trimestres sur autoentrepreneur.urssaf.fr. Le plafond du statut auto-entrepreneur est de 77 700€ de CA annuel. Au-delà, le chauffeur doit passer en société (EURL, SASU). Les cotisations incluent : maladie, retraite, CSG-CRDS, allocations familiales.

### Plafond auto-entrepreneur et régime réel
Le plafond micro-entrepreneur pour les prestations de service (VTC) est de 77 700€ de CA annuel en 2026. En micro-entrepreneur, l'État applique un abattement forfaitaire de 34% (il considère que 34% du CA sont des frais professionnels). Si les frais réels du chauffeur dépassent 34% de son CA (essence, assurance, crédit voiture, téléphone, entretien), il a intérêt à passer au régime réel pour payer des cotisations sur une base plus basse. Exemple : un chauffeur qui fait 50 000€ de CA avec 22 000€ de frais réels (44% du CA) perd environ 4 800€/an en restant au forfait micro. Le régime réel nécessite un comptable (300-500€/an) mais l'économie est souvent bien supérieure.

---

## SECTION 9 : OPTIMISATION FISCALE VTC

### Les frais déductibles (régime réel)
Essence et recharges électriques. Assurance véhicule (part professionnelle). Crédit ou leasing véhicule (intérêts + amortissement). Entretien et réparations. Pneus. Lavage véhicule. Parking et péages. Téléphone et forfait data (part professionnelle, généralement 70-80%). Commission des plateformes (Uber 25%, Bolt 15%, etc.). Assurance RC professionnelle. Formation continue. Vêtements professionnels. Cotisation registre VTC. Frais de comptabilité.

### L'ACCRE (ACRE) — La réduction que personne demande
L'ACRE (Aide aux Créateurs et Repreneurs d'Entreprise) permet une exonération de 50% des cotisations sociales pendant les 12 premiers mois d'activité. Sur un CA de 50 000€, c'est environ 6 000€ d'économie la première année. Conditions : ne pas avoir bénéficié de l'ACRE dans les 3 dernières années, être inscrit à Pôle Emploi ou bénéficier de minima sociaux. La demande se fait auprès de l'URSSAF dans les 45 jours suivant la création de l'auto-entreprise.

### TVA — Franchise en base
En dessous de 37 500€ de CA annuel, le chauffeur VTC bénéficie de la franchise en base de TVA : il ne facture pas de TVA et ne peut pas la récupérer. Au-dessus de 37 500€, il doit facturer la TVA (20%) et peut la récupérer sur ses achats. Pour un chauffeur qui achète un véhicule à 40 000€ TTC, ne pas pouvoir récupérer la TVA (6 667€) est un manque à gagner significatif. Dans certains cas, il est plus avantageux de dépasser volontairement le seuil de TVA pour récupérer la TVA sur un achat important.

---

## SECTION 10 : ÉVÉNEMENTS PARIS — IMPACT SUR LA DEMANDE VTC

### Salles de concert et événements
Accor Arena (Bercy) : capacité 20 300 places. Fin de concert = 15 000-20 000 personnes qui cherchent un VTC en même temps. Surge Uber garanti à 1.5x-2.5x. Se positionner 30 min avant la fin du concert sur le boulevard de Bercy ou la rue de Bercy. Stade de France (Saint-Denis) : capacité 80 000. Fin de match = chaos total. Temps d'attente client = 30-45 min. Mais les courses sont longues (Saint-Denis → Paris centre = 25-40€). Parc des Princes : capacité 48 000. Matchs PSG = forte demande. Se positionner porte de Saint-Cloud ou avenue du Parc des Princes. Zénith Paris (La Villette) : capacité 6 300. Plus petit mais clientèle premium. Salons Porte de Versailles : les salons professionnels (Salon de l'Agriculture, Mondial de l'Auto, etc.) génèrent un flux constant de 9h à 19h pendant plusieurs jours. Courses business, pourboires fréquents.

### Impact grèves RATP/SNCF
Une grève RATP (métro + RER) augmente la demande VTC de 200-400% pendant les heures de pointe. Le surge Uber peut atteindre 3x-5x. C'est le jackpot pour les chauffeurs VTC. Anticiper : suivre les préavis de grève sur ratp.fr et sncf.com. Se connecter tôt (6h30 au lieu de 8h) pour capter la demande dès le début. Zones les plus impactées : Châtelet, Gare du Nord, Gare de Lyon, La Défense, République.

### Impact météo sur la demande
Pluie : +20-30% de demande VTC (les gens qui marchent ou prennent le vélo basculent sur VTC). Surge léger (1.2x-1.5x). Pluie forte/orage : +40-60% de demande. Surge significatif (1.5x-2.5x). Neige : +100-200% de demande mais routes dangereuses. Conduire prudemment. Canicule (>35°C) : légère hausse de demande, les gens évitent de marcher. Froid intense (<0°C) : hausse modérée, surtout en soirée.

---

## SECTION 11 : GESTION DE LA FATIGUE — SÉCURITÉ ET PERFORMANCE

### La règle des 10 heures
Au-delà de 10 heures de conduite, les temps de réaction augmentent de 20-30% et le taux d'accidents double. Le €/h net chute aussi car le chauffeur fait des erreurs de positionnement, accepte des courses peu rentables par fatigue, et conduit plus lentement. La stratégie optimale : 8 heures bien placées valent mieux que 12 heures en roue libre.

### Créneaux optimaux pour maximiser le €/h
Le €/h net n'est pas linéaire dans la journée. Les créneaux les plus rentables : 7h-10h (rush matin, 18-25€/h net), 12h-14h (déjeuners, 15-18€/h net), 17h-20h30 (rush soir, 20-28€/h net), 22h-1h30 vendredi/samedi (nuit, 22-30€/h net). Les créneaux les moins rentables : 10h-12h (creux matin, 10-14€/h net), 14h-17h (après-midi calme, 10-15€/h net), 3h-7h (fin de nuit, 8-12€/h net sauf exception).

### Quand s'arrêter
Si le €/h net tombe sous 12€ pendant plus de 30 minutes, mieux vaut se déconnecter et reprendre plus tard à un créneau rentable. Rester connecté "au cas où" coûte de l'essence et de la fatigue pour un rendement médiocre.

---

## SECTION 12 : ERREURS COURANTES DES CHAUFFEURS VTC

### Erreur 1 : Rester dans la file VTC officielle
Les files VTC des gares et aéroports = temps d'attente non rémunéré. Se positionner en périphérie immédiate (200-300m) est presque toujours plus rentable car l'algorithme envoie les courses au plus proche du client, pas au plus ancien dans la file.

### Erreur 2 : Refuser les courses courtes
Une course courte (5€) qui t'emmène dans une zone chaude vaut plus qu'une longue attente pour une course longue. L'enchaînement rapide est la clé de la rentabilité. 4 courses à 8€ en 1 heure = 32€ brut > 1 course à 25€ qui a nécessité 20 min d'attente.

### Erreur 3 : Courir après le surge
Quand tu vois le surge monter dans une zone sur l'app, 50 autres chauffeurs le voient aussi. Le temps de te déplacer (10-15 min), le surge a souvent baissé ou disparu. La stratégie gagnante : anticiper le surge (sorties de concerts, fins de matchs, fermetures de bars) et se positionner AVANT.

### Erreur 4 : Ne pas déduire tous ses frais
En régime réel, chaque euro de frais non déclaré = 0,24€ de cotisations payées en trop. Un chauffeur qui oublie 200€/mois de frais paie 576€/an de trop à l'URSSAF. Les frais les plus souvent oubliés : parking, péages, lavage auto, part pro du téléphone, vêtements professionnels.

### Erreur 5 : Travailler les créneaux morts
Rester connecté de 14h à 17h un mardi rapporte en moyenne 10-12€/h net. C'est à peine au-dessus du SMIC. Mieux vaut se reposer et revenir pour le rush de 17h-20h à 20-25€/h net.
