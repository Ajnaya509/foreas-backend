# 🗺️ Carte des fonctionnalités de l'app — pour qu'Ajnaya CONNAISSE tout

> Source : graphify (`CARTE_APP_SIMPLE.md`) + dossier `src/screens` + Supabase.
> But : nourrir le **cerveau « Produit »** d'Ajnaya (RAG) pour le tour guidé live + les réponses détaillées.
> Format = celui de la table existante **`pieuvre_feature_catalog`** → drop-in pour le fil Pieuvre.
> Règle d'or : **simple**, **vrai** (jamais « humaine », « 100% », « garanti »), tutoiement.

---

## ✅ Ce qui est DÉJÀ dans `pieuvre_feature_catalog` (14) — ne pas re-créer
Guide · Sentinel · Coach · Debrief · Spy · Scraper · Tribal · Reputation · Compta IA ·
Ton site perso + QR (`driver_sites`) · Communauté (`community_enabled`) · Alertes zones push (`push_alerts`) ·
Parrainage 3 niveaux VIP (`mlm_system`) · Recruiter.

## ⚠️ Le champ qui MANQUE au catalogue (1 colonne à ajouter)
Pour que l'avatar live sache **quel écran montrer** (canvas), ajouter une colonne :
```sql
alter table public.pieuvre_feature_catalog add column if not exists canvas_screen text;
-- ex: 'HomeScreen', 'AjnayaScreen', 'CommunauteScreen', 'ClientsDirects', 'ArgentDashboard'
```
→ Quand Ajnaya parle d'une feature, elle réduit sa fenêtre et affiche `canvas_screen`.

---

## ➕ LES TROUS — fonctionnalités vues par le chauffeur, À AJOUTER au catalogue

> Chaque bloc = 1 ligne du catalogue. Lis-le comme une fiche : **où · c'est quoi · pour toi · ce qu'elle dit · à ne pas dire.**

### 🏠 ONGLET ACCUEIL

**1. Objectif du jour** — `feature_key: objectif_du_jour`
- **Écran (canvas)** : HomeScreen
- **Palier** : essentiel
- **C'est quoi** : ton but de gain du jour en **€/jour**, avec une barre qui se remplit au fil des courses.
- **Pour toi** : tu sais en un coup d'œil où t'en es, sans rien calculer.
- **Quand en parler** : onboarding, début de journée.
- **Ce qu'elle dit** : « En haut, ton objectif du jour. La barre se remplit toute seule pendant que tu roules — tu vois direct s'il te manque deux courses ou dix. »
- **À ne pas dire** : « objectif garanti ».

**2. Carte des zones chaudes** — `feature_key: carte_zones_chaudes`
- **Écran** : HomeScreen (la carte)
- **Palier** : essentiel (push pro)
- **C'est quoi** : la carte qui montre **où la demande chauffe en direct** (Pic / Forte / Modérée / Calme) + les « zones cachées ».
- **Pour toi** : tu te places là où ça paye, au lieu de tourner à l'aveugle.
- **Quand** : démarrage, creux d'activité, question « où aller ? ».
- **Ce qu'elle dit** : « Là, la carte. Le rouge, c'est là où ça demande fort maintenant. Tu te rapproches, t'attends moins. »
- **À ne pas dire** : « zones exactes garanties », « 100% des clients ».

**3. Y aller (navigation depuis une zone)** — `feature_key: navigation_gps`
- **Écran** : HomeScreen → RideNavigationScreen
- **Palier** : essentiel
- **C'est quoi** : un tap sur « Y aller » ouvre **Waze / Google Maps / Plans** vers la zone ou la destination.
- **Pour toi** : zéro friction, ton appli de nav préférée se lance.
- **Ce qu'elle dit** : « Tu cliques « Y aller », ça t'ouvre Waze direct. Tu choisis ton appli une fois, après c'est automatique. »
- **À ne pas dire** : « itinéraire le plus rapide garanti ».

### ⚡ TRANSVERSE — pendant la conduite

**4. Coach réflexe (accepter / refuser une course)** — `feature_key: coach_reflexe`
- **Écran** : superposition pendant une course proposée
- **Palier** : pro
- **C'est quoi** : quand une course arrive, il calcule **ton vrai net** (brut **moins** la commission Uber/Bolt/Heetch) en **moins d'une seconde** et te dit **accepte** ou **refuse**.
- **Pour toi** : tu ne prends plus les courses qui te font perdre de l'argent sans le voir.
- **Quand** : à chaque course, surtout les longues à vide.
- **Ce qu'elle dit** : « Une course tombe ? Je te sors ton net réel, commission déduite, avant que t'acceptes. Si c'est pas rentable, je te le dis. »
- **À ne pas dire** : « gain garanti par course », « refuse et tu gagnes plus à coup sûr ».

### ✨ ONGLET AJNAYA

**5. Ajnaya, ton copilote** — `feature_key: ajnaya_copilote`
- **Écran** : AjnayaScreen
- **Palier** : essentiel
- **C'est quoi** : tu lui **parles** (voix ou texte) ; elle te dit où aller, t'explique tes chiffres, répond à tes questions sur le métier.
- **Pour toi** : un copilote dispo tout le temps, qui connaît ta ville.
- **Ce qu'elle dit** : « L'onglet avec l'étoile, c'est moi. Tu me parles comme à un collègue — « où je vais ce soir ? » — et je te réponds. »
- **À ne pas dire** : « je suis humaine », « je réponds à tout sans erreur ».

### 👥 ONGLET COMMUNAUTÉ

**6. Entraide terrain (signalements)** — `feature_key: entraide_signalements`
- **Écran** : CommunauteScreen → Entraide
- **Palier** : essentiel
- **C'est quoi** : les chauffeurs se préviennent en direct — **contrôle police, accident, bouchon, danger** — avec le lieu et la distance par rapport à toi.
- **Pour toi** : t'es prévenu **avant** d'y être ; t'es plus seul sur la route.
- **Quand** : onboarding jour 2, sentiment d'isolement.
- **Ce qu'elle dit** : « Ici, les chauffeurs se signalent les trucs : un contrôle, un bouchon, un accident — avec la distance. Tu le sais avant d'arriver dessus. »
- **À ne pas dire** : « couverture 100% », « toutes les alertes sont vérifiées ».

**7. Astuces** — `feature_key: astuces_feed`
- **Écran** : CommunauteScreen → Astuces
- **Palier** : essentiel
- **C'est quoi** : un fil de **conseils terrain** (bons plans, gares, aéroports, créneaux).
- **Ce qu'elle dit** : « L'onglet Astuces, c'est les bons plans des autres chauffeurs. Deux minutes le matin, tu apprends un truc. »
- **À ne pas dire** : « formation certifiée ».

### 🤝 ONGLET CLIENTS

**8. Clients directs / Conciergerie** — `feature_key: clients_directs`
- **Écran** : ClientsDirectsNavigator (Prospects, Atelier commercial)
- **Palier** : pro / vip
- **C'est quoi** : FOREAS te trouve et t'aide à convertir des **clients qui réservent en direct avec toi**, sans passer par Uber → **zéro commission plateforme**.
- **Pour toi** : tu te construis une clientèle à toi, qui revient.
- **Quand** : question indépendance, plateau de revenus.
- **Ce qu'elle dit** : « L'onglet Clients, c'est tes courses à toi — des clients qui te réservent en direct. Pas de commission Uber là-dessus, c'est 100% pour ta poche. »
- **À ne pas dire** : « remplace totalement Uber », « X clients garantis ».

### 💰 ONGLET ARGENT

**9. Compta IA (détail)** — *complète la feature existante `pieuvre_compta_active`*
- **Écran** : ArgentDashboard → Comptabilité (Simulateur, Déclaration, Dépenses)
- **Palier** : pro (export illimité VIP)
- **C'est quoi** : suit ton **CA, tes charges, ta marge** ; simulateur URSSAF ; rappels de déclaration ; suivi des dépenses.
- **Ce qu'elle dit** : « La Compta te fait le point fin de mois — CA, charges, ce qui te reste vraiment. Tu n'ouvres jamais Excel. »
- **À ne pas dire** : « conseil fiscal personnalisé ».

**10. Portefeuille / paiements directs** — `feature_key: wallet_paiements`
- **Écran** : ArgentDashboard → Wallet
- **Palier** : pro
- **C'est quoi** : tu **reçois l'argent** de tes clients directs (via Stripe) sur ton compte.
- **Pour toi** : l'argent de tes courses directes arrive chez toi, propre et tracé.
- **Ce qu'elle dit** : « Tes clients directs te paient ici, direct sur ton compte. »
- **À ne pas dire** : « versement instantané garanti ».

**11. Stats & performance** — `feature_key: statistiques`
- **Écran** : ArgentDashboard → Stats
- **Palier** : essentiel
- **C'est quoi** : ton **net par heure (€/h)**, ton **€/km**, ton historique, ton temps à vide.
- **Pour toi** : tu sais ce qui marche vraiment, pas juste le brut qui fait plaisir.
- **Ce qu'elle dit** : « Tes stats : ton net par heure, ton temps à vide. C'est là que tu vois où tu perds du temps. »
- **À ne pas dire** : « comparaison nominative avec d'autres chauffeurs ».

### 🎟️ RÉGLAGES

**12. Tes paliers (Essentiel / Pro / VIP)** — `feature_key: abonnement_paliers`
- **Écran** : SubscriptionScreen
- **Palier** : info (tous)
- **C'est quoi** : ce que débloque chaque formule (Essentiel = base + communauté + alertes ; Pro = Coach + Compta + Clients directs + site perso ; VIP = Spy + parrainage 3 niveaux + export illimité).
- **Ce qu'elle dit** : « Trois formules. Essentiel pour démarrer, Pro pour gagner plus, VIP pour le parrainage et la veille concurrents. Tu changes quand tu veux. »
- **À ne pas dire** : « engagement obligatoire », chiffres de prix inventés (lire `pieuvre_pricing_plans`).

---

## 🔌 Comment ça alimente le live
1. Le fil **Pieuvre** insère ces lignes dans `pieuvre_feature_catalog` (+ colonne `canvas_screen`) et/ou les indexe dans le RAG (`document_chunks`).
2. Le cerveau d'Ajnaya **récupère** la bonne fiche selon la question → répond avec `ajnaya_voice_script` **ET** affiche `canvas_screen` (canvas).
3. **Truthful UX** : `forbidden_claims` empêche l'hallucination → elle ne dit que ce qui est vrai dans l'app.

> ⚠️ Prix : ne JAMAIS inventer — Ajnaya lit `pieuvre_pricing_plans` (4 lignes) pour les montants.
