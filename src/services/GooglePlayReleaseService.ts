/**
 * GooglePlayReleaseService — vraie version en ligne sur le Play Store,
 * en direct depuis Google (miroir du fix iOS via l'iTunes Lookup API).
 *
 * Play Developer API n'a pas de "GET current version" simple : il faut
 * ouvrir un edit (transaction en lecture), lire la piste "production",
 * puis le refermer SANS le publier (edits.delete — jamais edits.commit,
 * on ne modifie jamais rien côté Play, on lit seulement).
 *
 * Auth : GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (contenu JSON complet du compte
 * de service, lecture seule sur Play Console — "Voir les infos de l'app").
 *
 * Cache en mémoire process (6h, même convention que ZoneScoreCache.ts) :
 * jamais plus d'un appel Play API par redémarrage/6h, jamais bloquant —
 * une erreur renvoie le dernier résultat connu (ou null), jamais throw.
 */
import { google } from 'googleapis';

const PACKAGE_NAME = 'com.chandler509.foreasdriver';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cache: { versionCode: number | null; fetchedAt: number } | null = null;

function getServiceAccountCredentials(): Record<string, any> | null {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e: any) {
    console.error('[GooglePlayRelease] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON invalide:', e?.message);
    return null;
  }
}

async function fetchLatestProductionVersionCode(): Promise<number | null> {
  const credentials = getServiceAccountCredentials();
  if (!credentials) return null;

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  const androidpublisher = google.androidpublisher({ version: 'v3', auth });

  let editId: string | null = null;
  try {
    const edit = await androidpublisher.edits.insert({ packageName: PACKAGE_NAME });
    editId = edit.data.id ?? null;
    if (!editId) return null;

    const track = await androidpublisher.edits.tracks.get({
      packageName: PACKAGE_NAME,
      editId,
      track: 'production',
    });

    let maxVersionCode: number | null = null;
    for (const release of track.data.releases ?? []) {
      if (release.status !== 'completed') continue;
      for (const vc of release.versionCodes ?? []) {
        const n = parseInt(String(vc), 10);
        if (Number.isFinite(n) && (maxVersionCode === null || n > maxVersionCode)) {
          maxVersionCode = n;
        }
      }
    }
    return maxVersionCode;
  } finally {
    // Jamais edits.commit — on lit, on ne publie rien. Nettoyage best-effort.
    if (editId) {
      androidpublisher.edits.delete({ packageName: PACKAGE_NAME, editId }).catch(() => {});
    }
  }
}

/** Best-effort, jamais throw : erreur ou credentials absents → dernier cache connu, sinon null. */
export async function getCachedLatestAndroidVersionCode(): Promise<number | null> {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh) return cache!.versionCode;

  try {
    const versionCode = await fetchLatestProductionVersionCode();
    cache = { versionCode, fetchedAt: Date.now() };
    return versionCode;
  } catch (e: any) {
    console.error('[GooglePlayRelease] fetch error:', e?.message);
    // Panne ponctuelle : autant garder le dernier résultat connu qu'un null sec.
    return cache?.versionCode ?? null;
  }
}
