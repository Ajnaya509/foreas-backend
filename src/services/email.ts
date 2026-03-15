/**
 * FOREAS Email Service — Resend
 *
 * 15 emails automatiques avec ADN FOREAS.
 * Email #13 (fraude) → admin uniquement (vitium@foreas.xyz).
 * Copywriting FR, tutoiement, ton direct et motivant.
 */

import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function send(params: {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
}) {
  if (!resend) {
    console.warn(
      '[Email] RESEND_API_KEY manquante — email ignoré:',
      params.subject,
      '→',
      params.to,
    );
    return;
  }
  const { error } = await resend.emails.send(params);
  if (error) console.error('[Email] Erreur Resend:', error);
}

const FROM = 'FOREAS <noreply@foreas.xyz>';
const ADMIN_EMAIL = 'vitium@foreas.xyz';
const SUPPORT_EMAIL = 'support@foreas.xyz';
const APP_URL = 'https://foreas.xyz';

// ── Helpers ──

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body{margin:0;padding:0;background:#080C18;font-family:'Inter',Helvetica,Arial,sans-serif;color:#fff}
  .wrap{max-width:560px;margin:0 auto;padding:40px 24px}
  .logo{text-align:center;margin-bottom:32px;font-size:28px;font-weight:800;letter-spacing:2px;color:#8C52FF}
  .card{background:#0B1120;border-radius:16px;padding:32px 24px;border:1px solid rgba(0,201,255,0.08)}
  h1{font-size:22px;font-weight:700;margin:0 0 16px;color:#fff}
  p{font-size:15px;line-height:1.6;color:rgba(255,255,255,0.75);margin:0 0 16px}
  .cta{display:inline-block;background:linear-gradient(135deg,#4A90E2,#8C52FF);color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:600;font-size:15px;margin:8px 0 16px}
  .highlight{color:#8C52FF;font-weight:600}
  .muted{font-size:13px;color:rgba(255,255,255,0.4);text-align:center;margin-top:32px}
  .muted a{color:rgba(255,255,255,0.4);text-decoration:underline}
  .badge{display:inline-block;background:rgba(140,82,255,0.15);color:#8C52FF;padding:6px 14px;border-radius:8px;font-weight:600;font-size:13px}
  .alert{background:#1a0a0a;border:1px solid #EF4444}
  .alert h1{color:#EF4444}
  .success{background:#0a1a0a;border:1px solid #22C55E}
  .success h1{color:#22C55E}
  .warning{background:#1a1a0a;border:1px solid #F59E0B}
  .warning h1{color:#F59E0B}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">FOREAS</div>
  <div class="card${title.includes('Alerte') ? ' alert' : ''}">
    ${body}
  </div>
  <div class="muted">
    <p>FOREAS Labs &mdash; Toujours plus loin.</p>
    <p><a href="${APP_URL}/cgu">CGU</a> &bull; <a href="${APP_URL}/confidentialite">Confidentialite</a></p>
  </div>
</div>
</body>
</html>`;
}

// ── 1. Bienvenue (inscription) ──

export async function sendWelcome(email: string, name: string) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: `Bienvenue ${firstName} — FOREAS est pret pour toi`,
    html: layout(
      'Bienvenue',
      `
      <h1>Bienvenue a bord, ${firstName}.</h1>
      <p>Tu fais maintenant partie de FOREAS. L'app qui te donne un avantage reel sur la route.</p>
      <p>Ajnaya, ton copilote IA, t'attend. Chaque course compte. Chaque decision est optimisee.</p>
      <a href="${APP_URL}" class="cta">Ouvrir FOREAS</a>
      <p>Une question ? Reponds a cet email, on est la.</p>
    `,
    ),
  });
}

// ── 2. Verification email ──

export async function sendEmailVerification(email: string, token: string) {
  const verifyUrl = `${APP_URL}/verify?token=${token}`;

  return send({
    from: FROM,
    to: email,
    subject: 'Confirme ton email — FOREAS',
    html: layout(
      'Verification',
      `
      <h1>Confirme ton adresse email</h1>
      <p>Clique sur le bouton ci-dessous pour verifier ton email et debloquer toutes les fonctionnalites de FOREAS.</p>
      <a href="${verifyUrl}" class="cta">Verifier mon email</a>
      <p class="muted">Ce lien expire dans 24h. Si tu n'as pas cree de compte FOREAS, ignore cet email.</p>
    `,
    ),
  });
}

// ── 3. Mot de passe oublie ──

export async function sendPasswordReset(email: string, token: string) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  return send({
    from: FROM,
    to: email,
    subject: 'Reinitialise ton mot de passe — FOREAS',
    html: layout(
      'Mot de passe',
      `
      <h1>Reinitialisation du mot de passe</h1>
      <p>Tu as demande a reinitialiser ton mot de passe FOREAS. Clique ci-dessous pour en choisir un nouveau.</p>
      <a href="${resetUrl}" class="cta">Nouveau mot de passe</a>
      <p>Ce lien est valide 1 heure. Si tu n'as rien demande, ignore cet email — ton compte est en securite.</p>
    `,
    ),
  });
}

// ── 4. Abonnement active ──

export async function sendSubscriptionActivated(email: string, name: string, planName: string) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: `Abonnement ${planName} active — FOREAS`,
    html: layout(
      'Abonnement active',
      `
      <div class="card success">
        <h1>Abonnement active</h1>
        <p>${firstName}, ton abonnement <span class="highlight">${planName}</span> est maintenant actif.</p>
        <p>Tu as desormais acces a tout : Ajnaya sans limites, analyses avancees, zones premium et bien plus.</p>
        <p>La route t'attend. Fais-en le maximum.</p>
        <a href="${APP_URL}" class="cta">Ouvrir FOREAS</a>
      </div>
    `,
    ),
  });
}

// ── 5. Paiement reussi (renouvellement) ──

export async function sendPaymentSucceeded(
  email: string,
  name: string,
  amount: string,
  nextDate: string,
) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: 'Paiement confirme — FOREAS',
    html: layout(
      'Paiement',
      `
      <h1>Paiement confirme</h1>
      <p>${firstName}, ton paiement de <span class="highlight">${amount}</span> a ete traite avec succes.</p>
      <p>Prochain renouvellement : ${nextDate}.</p>
      <p>Continue a rouler, Ajnaya veille sur ta performance.</p>
    `,
    ),
  });
}

// ── 6. Echec de paiement (1ere tentative) ──

export async function sendPaymentFailed1(email: string, name: string) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: 'Echec de paiement — Action requise',
    html: layout(
      'Echec paiement',
      `
      <div class="card warning">
        <h1>Echec de paiement</h1>
        <p>${firstName}, ton dernier paiement FOREAS n'a pas abouti. Ca arrive — il suffit de mettre a jour ton moyen de paiement.</p>
        <p>On va retenter automatiquement dans quelques jours. Pour eviter toute interruption :</p>
        <a href="${APP_URL}/billing" class="cta">Mettre a jour le paiement</a>
        <p>Besoin d'aide ? Contacte-nous a ${SUPPORT_EMAIL}.</p>
      </div>
    `,
    ),
  });
}

// ── 7. Echec de paiement (2eme relance) ──

export async function sendPaymentFailed2(email: string, name: string) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: 'Deuxieme tentative echouee — Mets a jour ton paiement',
    html: layout(
      'Relance paiement',
      `
      <div class="card warning">
        <h1>Deuxieme tentative echouee</h1>
        <p>${firstName}, on n'arrive toujours pas a prelever ton abonnement FOREAS. Il reste une derniere tentative avant la suspension de ton compte.</p>
        <p><strong>Ton acces a Ajnaya et aux fonctionnalites premium sera coupe si le paiement echoue a nouveau.</strong></p>
        <a href="${APP_URL}/billing" class="cta">Corriger maintenant</a>
      </div>
    `,
    ),
  });
}

// ── 8. Echec de paiement (derniere chance) ──

export async function sendPaymentFailedFinal(email: string, name: string) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: 'Derniere chance — Ton abonnement FOREAS va etre suspendu',
    html: layout(
      'Derniere chance',
      `
      <div class="card alert">
        <h1>Derniere tentative</h1>
        <p>${firstName}, c'est la derniere chance pour conserver ton abonnement FOREAS actif.</p>
        <p>Si le paiement echoue a nouveau, ton acces premium sera <strong>suspendu immediatement</strong>. Plus d'Ajnaya, plus d'analyses, plus de zones premium.</p>
        <a href="${APP_URL}/billing" class="cta">Sauver mon abonnement</a>
        <p>Si tu rencontres un probleme, contacte-nous : ${SUPPORT_EMAIL}</p>
      </div>
    `,
    ),
  });
}

// ── 9. Abonnement suspendu ──

export async function sendSubscriptionSuspended(email: string, name: string) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: 'Abonnement suspendu — FOREAS',
    html: layout(
      'Suspension',
      `
      <div class="card alert">
        <h1>Abonnement suspendu</h1>
        <p>${firstName}, ton abonnement FOREAS a ete suspendu suite aux echecs de paiement repetes.</p>
        <p>Tu peux toujours acceder a l'app en mode limite. Pour retrouver toutes tes fonctionnalites premium :</p>
        <a href="${APP_URL}/billing" class="cta">Reactiver mon abonnement</a>
        <p>Ton historique et tes donnees sont conserves. On t'attend.</p>
      </div>
    `,
    ),
  });
}

// ── 10. Abonnement annule ──

export async function sendSubscriptionCanceled(email: string, name: string) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: 'Abonnement annule — On reste la',
    html: layout(
      'Annulation',
      `
      <h1>Abonnement annule</h1>
      <p>${firstName}, ton abonnement FOREAS a ete annule. On respecte ton choix.</p>
      <p>Tes donnees restent disponibles si tu souhaites revenir. Ajnaya sera toujours prete a t'accompagner.</p>
      <a href="${APP_URL}/pricing" class="cta">Se reabonner</a>
      <p>Un retour ? Un probleme ? Ecris-nous a ${SUPPORT_EMAIL} — on ecoute.</p>
    `,
    ),
  });
}

// ── 11. Abonnement reactive ──

export async function sendSubscriptionReactivated(email: string, name: string, planName: string) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: `Content de te revoir — Abonnement ${planName} reactif`,
    html: layout(
      'Reactivation',
      `
      <div class="card success">
        <h1>Bon retour, ${firstName}.</h1>
        <p>Ton abonnement <span class="highlight">${planName}</span> est a nouveau actif. Toutes les fonctionnalites premium sont debloquees.</p>
        <p>Ajnaya t'attendait. Reprends la route avec un avantage.</p>
        <a href="${APP_URL}" class="cta">Ouvrir FOREAS</a>
      </div>
    `,
    ),
  });
}

// ── 12. Changement de plan ──

export async function sendPlanChanged(
  email: string,
  name: string,
  oldPlan: string,
  newPlan: string,
) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: `Plan modifie : ${oldPlan} → ${newPlan}`,
    html: layout(
      'Changement de plan',
      `
      <h1>Plan mis a jour</h1>
      <p>${firstName}, tu es passe de <span class="highlight">${oldPlan}</span> a <span class="highlight">${newPlan}</span>.</p>
      <p>Les modifications prennent effet immediatement. Tu profites deja des avantages de ton nouveau plan.</p>
      <a href="${APP_URL}" class="cta">Voir mon compte</a>
    `,
    ),
  });
}

// ── 13. Alerte fraude → ADMIN UNIQUEMENT ──

export async function sendFraudAlert(data: {
  userId: string;
  email: string;
  score: number;
  riskLevel: string;
  signals: Record<string, any>;
  action: string;
}) {
  const signalLines = Object.entries(data.signals)
    .map(([k, v]) => `<li><strong>${k}</strong>: ${JSON.stringify(v)}</li>`)
    .join('');

  return send({
    from: FROM,
    to: ADMIN_EMAIL,
    subject: `[SECURITE] Alerte fraude — Score ${data.score}/100 — ${data.riskLevel}`,
    html: layout(
      'Alerte Securite',
      `
      <div class="card alert">
        <h1>Alerte Fraude Detectee</h1>
        <p><strong>Utilisateur :</strong> ${data.email} (${data.userId})</p>
        <p><strong>Score :</strong> <span class="highlight">${data.score}/100</span></p>
        <p><strong>Niveau :</strong> <span class="badge">${data.riskLevel.toUpperCase()}</span></p>
        <p><strong>Action prise :</strong> ${data.action}</p>
        <p><strong>Signaux :</strong></p>
        <ul style="color:rgba(255,255,255,0.75);font-size:14px;line-height:1.8">${signalLines}</ul>
        <p style="margin-top:16px;font-size:13px;color:rgba(255,255,255,0.4)">
          Cet email est envoye automatiquement a l'equipe admin FOREAS. Ne pas transmettre.
        </p>
      </div>
    `,
    ),
  });
}

// ── 14. Parrainage valide ──

export async function sendReferralValidated(
  email: string,
  name: string,
  referredName: string,
  commission: string,
) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: `Parrainage valide — ${commission} gagnes`,
    html: layout(
      'Parrainage',
      `
      <div class="card success">
        <h1>Parrainage valide</h1>
        <p>${firstName}, <strong>${referredName}</strong> a souscrit grace a ton lien. Ta commission de <span class="highlight">${commission}</span> est en cours de traitement.</p>
        <p>Continue a partager ton code — chaque parrainage compte.</p>
        <a href="${APP_URL}" class="cta">Voir mes parrainages</a>
      </div>
    `,
    ),
  });
}

// ── 15. Commission versee ──

export async function sendCommissionPaid(
  email: string,
  name: string,
  amount: string,
  method: string,
) {
  const firstName = name.split(' ')[0] || 'Chauffeur';

  return send({
    from: FROM,
    to: email,
    subject: `Commission versee — ${amount}`,
    html: layout(
      'Commission',
      `
      <div class="card success">
        <h1>Commission versee</h1>
        <p>${firstName}, <span class="highlight">${amount}</span> ont ete verses sur ton ${method}.</p>
        <p>Le virement sera visible sous 2-3 jours ouvres. Continue a developper ton reseau FOREAS.</p>
        <a href="${APP_URL}" class="cta">Voir mon wallet</a>
      </div>
    `,
    ),
  });
}

// ── Namespace export ──

const EmailService = {
  sendWelcome,
  sendEmailVerification,
  sendPasswordReset,
  sendSubscriptionActivated,
  sendPaymentSucceeded,
  sendPaymentFailed1,
  sendPaymentFailed2,
  sendPaymentFailedFinal,
  sendSubscriptionSuspended,
  sendSubscriptionCanceled,
  sendSubscriptionReactivated,
  sendPlanChanged,
  sendFraudAlert,
  sendReferralValidated,
  sendCommissionPaid,
};

export default EmailService;
