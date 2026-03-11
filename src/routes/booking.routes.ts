/**
 * Booking Routes — FOREAS Driver Site
 * ════════════════════════════════════
 * Endpoints concrets pour le systeme de reservation client.
 *
 * POST /api/bookings              → Nouvelle reservation (formulaire public)
 * GET  /api/bookings/:id          → Detail d'une reservation
 * GET  /api/bookings/driver/:did  → Reservations d'un chauffeur
 * POST /api/bookings/:id/confirm  → Chauffeur confirme
 * POST /api/bookings/:id/cancel   → Annulation
 * POST /api/bookings/process-reminders → CRON: envoie les rappels pending
 */

import { Router, Request, Response } from 'express';

const router = Router();

// ─── Lazy-loaded dependencies ────────────────────────────────────────────────

let supabaseAdmin: any = null;
let resendClient: any = null;

async function getSupa() {
  if (!supabaseAdmin) {
    const { createClient } = await import('@supabase/supabase-js');
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return supabaseAdmin;
}

async function getResend() {
  if (!resendClient) {
    const { Resend } = await import('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

// ─── SMS (Bird API + MessageBird REST fallback, same as OTP) ─────────────────

const BIRD_API_KEY = () => process.env.BIRD_API_KEY || process.env.MESSAGEBIRD_API_KEY || '';
const BIRD_WORKSPACE_ID = () => process.env.BIRD_WORKSPACE_ID || 'default';
const BIRD_CHANNEL_ID = () => process.env.BIRD_CHANNEL_ID || '';

async function sendSMS(phone: string, message: string): Promise<boolean> {
  const apiKey = BIRD_API_KEY();
  if (!apiKey) {
    console.warn('[SMS] No API key configured — skipping SMS to', phone);
    return false;
  }

  const channelId = BIRD_CHANNEL_ID();
  const workspaceId = BIRD_WORKSPACE_ID();

  // Strategy 1: Bird API (if channel configured)
  if (channelId) {
    try {
      const resp = await fetch(
        `https://api.bird.com/workspaces/${workspaceId}/channels/${channelId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            receiver: {
              contacts: [{ identifierValue: phone, identifierKey: 'phonenumber' }],
            },
            body: { type: 'text', text: { text: message } },
          }),
        },
      );

      if (resp.ok) {
        console.log('[SMS] ✅ Sent via Bird to', phone.substring(0, 6) + '***');
        return true;
      }
      const err = await resp.text();
      console.error('[SMS] Bird error:', resp.status, err, '→ trying MessageBird fallback');
    } catch (err: any) {
      console.error('[SMS] Bird failed:', err.message, '→ trying MessageBird fallback');
    }
  }

  // Strategy 2: MessageBird REST API fallback (no channel needed)
  try {
    const resp = await fetch('https://rest.messagebird.com/messages', {
      method: 'POST',
      headers: {
        Authorization: `AccessKey ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        originator: 'FOREAS',
        recipients: [phone],
        body: message,
      }),
    });

    if (resp.ok) {
      console.log('[SMS] ✅ Sent via MessageBird to', phone.substring(0, 6) + '***');
      return true;
    }
    const err = await resp.text();
    console.error('[SMS] MessageBird error:', resp.status, err);
    return false;
  } catch (err: any) {
    console.error('[SMS] All providers failed:', err.message);
    return false;
  }
}

// ─── Email via Resend ────────────────────────────────────────────────────────

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<boolean> {
  try {
    const resend = await getResend();
    // Use verified domain foreas.xyz OR env override
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@foreas.xyz';

    const { error } = await resend.emails.send({
      from: `FOREAS <${fromEmail}>`,
      to: [to],
      subject,
      html,
      text,
    });

    if (error) {
      console.error('[Email] Resend error:', error);
      return false;
    }

    console.log('[Email] Sent to', to);
    return true;
  } catch (err: any) {
    console.error('[Email] Send failed:', err.message);
    return false;
  }
}

// ─── Notification Templates (inline for self-contained backend) ──────────────

function formatPrice(amount: number): string {
  return `${amount.toFixed(2).replace('.', ',')} \u20AC`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function clientConfirmEmail(b: any): { subject: string; html: string; text: string } {
  const dateStr = formatDateTime(b.scheduled_at);
  const priceStr = formatPrice(b.estimated_price);

  return {
    subject: `\u2705 Reservation confirmee \u2022 ${dateStr}`,
    html: `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0A0A14;color:#FFF}.c{max-width:520px;margin:0 auto;padding:32px 20px}.h{text-align:center;margin-bottom:32px}.logo{font-size:24px;font-weight:800;letter-spacing:2px;color:#8C52FF}.card{background:rgba(255,255,255,0.04);border:1px solid rgba(140,82,255,0.2);border-radius:16px;padding:24px;margin-bottom:20px}.title{font-size:20px;font-weight:700;margin:0 0 16px}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px}.lbl{color:rgba(255,255,255,0.5)}.val{color:#FFF;font-weight:600;text-align:right}.price{font-size:28px;font-weight:800;color:#8C52FF;text-align:center;margin:16px 0}.ft{text-align:center;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);margin-top:32px;font-size:11px;color:rgba(255,255,255,0.2)}</style></head><body><div class="c"><div class="h"><div class="logo">FOREAS</div><div style="font-size:11px;color:rgba(255,255,255,0.3);margin-top:4px;letter-spacing:3px;text-transform:uppercase">Votre chauffeur VTC</div></div><div class="card"><h2 class="title">\u2705 Reservation confirmee</h2><p style="color:rgba(255,255,255,0.6);font-size:14px">${b.site_slug} vous attend.</p><div class="price">${priceStr}</div><p style="text-align:center;font-size:11px;color:rgba(255,255,255,0.3)">Prix estime</p></div><div class="card"><div class="row"><span class="lbl">Depart</span><span class="val">${b.pickup_address}</span></div><div class="row"><span class="lbl">Arrivee</span><span class="val">${b.dropoff_address}</span></div><div class="row"><span class="lbl">Date</span><span class="val">${dateStr}</span></div><div class="row"><span class="lbl">Distance</span><span class="val">~${b.estimated_distance_km.toFixed(1)} km</span></div><div class="row" style="border:none"><span class="lbl">Duree</span><span class="val">~${b.estimated_duration_min} min</span></div></div><div style="background:rgba(140,82,255,0.08);border:1px solid rgba(140,82,255,0.15);border-radius:12px;padding:16px;margin:16px 0"><p style="margin:6px 0;font-size:13px;color:rgba(255,255,255,0.6)">\uD83D\uDCF1 Rappels automatiques :</p><p style="margin:6px 0;font-size:13px;color:rgba(255,255,255,0.6)">\u2022 SMS de rappel 2h avant</p><p style="margin:6px 0;font-size:13px;color:rgba(255,255,255,0.6)">\u2022 SMS 15 min avant le depart</p></div><div class="ft"><p>FOREAS Labs \u00A9 2026</p></div></div></body></html>`,
    text: `FOREAS - Reservation confirmee\n\nDepart: ${b.pickup_address}\nArrivee: ${b.dropoff_address}\nDate: ${dateStr}\nPrix estime: ${priceStr}\n\nVous recevrez un SMS de rappel 2h et 15min avant.`,
  };
}

function driverNotifyEmail(
  b: any,
  driverName: string,
): { subject: string; html: string; text: string } {
  const dateStr = formatDateTime(b.scheduled_at);
  const priceStr = formatPrice(b.estimated_price);

  return {
    subject: `\uD83D\uDE97 Nouvelle reservation \u2022 ${dateStr} \u2022 ${priceStr}`,
    html: `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0A0A14;color:#FFF}.c{max-width:520px;margin:0 auto;padding:32px 20px}.h{text-align:center;margin-bottom:32px}.logo{font-size:24px;font-weight:800;letter-spacing:2px;color:#8C52FF}.card{background:rgba(255,255,255,0.04);border:1px solid rgba(140,82,255,0.2);border-radius:16px;padding:24px;margin-bottom:20px}.title{font-size:20px;font-weight:700;margin:0 0 16px}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px}.lbl{color:rgba(255,255,255,0.5)}.val{color:#FFF;font-weight:600;text-align:right}.price{font-size:28px;font-weight:800;color:#8C52FF;text-align:center;margin:16px 0}.ft{text-align:center;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);margin-top:32px;font-size:11px;color:rgba(255,255,255,0.2)}</style></head><body><div class="c"><div class="h"><div class="logo">FOREAS</div></div><div class="card"><h2 class="title">\uD83D\uDE97 Nouvelle reservation</h2><p style="color:rgba(255,255,255,0.6);font-size:14px">${driverName}, nouvelle demande de course.</p><div class="price">${priceStr}</div></div><div class="card"><div class="row"><span class="lbl">Client</span><span class="val">${b.client_name || 'Non renseigne'}</span></div><div class="row"><span class="lbl">Tel</span><span class="val"><a href="tel:${b.client_phone}" style="color:#8C52FF">${b.client_phone}</a></span></div><div class="row"><span class="lbl">Email</span><span class="val">${b.client_email}</span></div><div class="row"><span class="lbl">Depart</span><span class="val">${b.pickup_address}</span></div><div class="row"><span class="lbl">Arrivee</span><span class="val">${b.dropoff_address}</span></div><div class="row"><span class="lbl">Date</span><span class="val">${dateStr}</span></div><div class="row" style="border:none"><span class="lbl">Distance</span><span class="val">~${b.estimated_distance_km.toFixed(1)} km</span></div>${b.client_note ? `<div class="row" style="border:none"><span class="lbl">Message</span><span class="val">${b.client_note}</span></div>` : ''}</div><div class="ft"><p>FOREAS Labs \u00A9 2026</p></div></div></body></html>`,
    text: `FOREAS - Nouvelle reservation\n\nClient: ${b.client_name || 'Non renseigne'}\nTel: ${b.client_phone}\nEmail: ${b.client_email}\nDepart: ${b.pickup_address}\nArrivee: ${b.dropoff_address}\nDate: ${dateStr}\nPrix: ${priceStr}\n\nContactez le client pour confirmer.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/bookings — Nouvelle reservation (appele depuis le formulaire public)
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/', async (req: Request, res: Response) => {
  const b = req.body || {};

  // Accept both camelCase (from HTML form) and snake_case
  const site_slug = b.site_slug || b.siteSlug;
  const client_name = b.client_name || b.clientName || '';
  const client_phone = b.client_phone || b.clientPhone;
  const client_email = b.client_email || b.clientEmail;
  const client_note = b.client_note || b.clientNote || '';
  const pickup_address = b.pickup_address || b.pickupAddress;
  const pickup_lat = b.pickup_lat ?? b.pickupLat ?? 0;
  const pickup_lng = b.pickup_lng ?? b.pickupLng ?? 0;
  const dropoff_address = b.dropoff_address || b.dropoffAddress;
  const dropoff_lat = b.dropoff_lat ?? b.dropoffLat ?? 0;
  const dropoff_lng = b.dropoff_lng ?? b.dropoffLng ?? 0;
  const estimated_distance_km = b.estimated_distance_km ?? b.estimatedDistanceKm ?? 0;
  const estimated_duration_min = b.estimated_duration_min ?? b.estimatedDurationMin ?? 0;
  const estimated_price = b.estimated_price ?? b.estimatedPrice ?? 0;
  const scheduled_at = b.scheduled_at || b.scheduledAt;

  // Validation
  if (
    !site_slug ||
    !client_phone ||
    !client_email ||
    !pickup_address ||
    !dropoff_address ||
    !scheduled_at
  ) {
    return res.status(400).json({
      error: 'Champs requis manquants',
      required: [
        'siteSlug',
        'clientPhone',
        'clientEmail',
        'pickupAddress',
        'dropoffAddress',
        'scheduledAt',
      ],
    });
  }

  if (!estimated_price || estimated_price < 0) {
    return res.status(400).json({ error: 'Prix estime invalide' });
  }

  const scheduledDate = new Date(scheduled_at);
  if (isNaN(scheduledDate.getTime()) || scheduledDate.getTime() < Date.now() + 30 * 60 * 1000) {
    return res.status(400).json({ error: "Date invalide (minimum 30min a l'avance)" });
  }

  try {
    const supa = await getSupa();

    // 1. Trouver le site et le chauffeur
    const { data: site, error: siteErr } = await supa
      .from('driver_sites')
      .select('id, driver_id, display_name')
      .eq('slug', site_slug)
      .eq('is_active', true)
      .single();

    if (siteErr || !site) {
      return res.status(404).json({ error: 'Site chauffeur introuvable' });
    }

    // 2. Creer la reservation
    const { data: booking, error: bookingErr } = await supa
      .from('bookings')
      .insert({
        driver_id: site.driver_id,
        site_slug,
        client_name: client_name || null,
        client_phone,
        client_email,
        client_note: client_note || null,
        pickup_address,
        pickup_lat: pickup_lat || 0,
        pickup_lng: pickup_lng || 0,
        dropoff_address,
        dropoff_lat: dropoff_lat || 0,
        dropoff_lng: dropoff_lng || 0,
        estimated_distance_km: estimated_distance_km || 0,
        estimated_duration_min: estimated_duration_min || 0,
        estimated_price,
        scheduled_at: scheduledDate.toISOString(),
        status: 'pending',
      })
      .select()
      .single();

    if (bookingErr) throw new Error(bookingErr.message);

    console.log(
      `[Booking] Created ${booking.id} for ${site_slug} — ${formatPrice(estimated_price)}`,
    );

    // 3. Planifier les rappels SMS
    const reminders = [
      {
        booking_id: booking.id,
        reminder_type: 'client_sms_2h',
        scheduled_for: new Date(scheduledDate.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      },
      {
        booking_id: booking.id,
        reminder_type: 'client_sms_15m',
        scheduled_for: new Date(scheduledDate.getTime() - 15 * 60 * 1000).toISOString(),
      },
      {
        booking_id: booking.id,
        reminder_type: 'driver_push_1h',
        scheduled_for: new Date(scheduledDate.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      },
      {
        booking_id: booking.id,
        reminder_type: 'driver_ajnaya_1h',
        scheduled_for: new Date(scheduledDate.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      },
    ].filter((r) => new Date(r.scheduled_for).getTime() > Date.now()); // Ne pas planifier si deja passe

    if (reminders.length > 0) {
      await supa.from('scheduled_reminders').insert(reminders);
      console.log(`[Booking] ${reminders.length} reminders scheduled`);
    }

    // 4. Envoyer les notifications INSTANTANEES (email client + email chauffeur)
    // En parallele, non-bloquant
    const notifResults = { clientEmail: false, driverEmail: false };

    // Trouver l'email du chauffeur
    const { data: driver } = await supa
      .from('drivers')
      .select('email, first_name, last_name')
      .eq('id', site.driver_id)
      .single();

    const driverEmail = driver?.email;
    const driverName = driver
      ? `${driver.first_name || ''} ${driver.last_name || ''}`.trim()
      : site.display_name;

    // Envoyer en parallele
    const emailPromises: Promise<void>[] = [];

    // Email confirmation client
    const clientMail = clientConfirmEmail(booking);
    emailPromises.push(
      sendEmail(client_email, clientMail.subject, clientMail.html, clientMail.text).then((ok) => {
        notifResults.clientEmail = ok;
        if (ok) {
          supa
            .from('bookings')
            .update({
              notifications: {
                ...booking.notifications,
                client_confirm_email_sent: true,
                client_confirm_email_sent_at: new Date().toISOString(),
              },
            })
            .eq('id', booking.id)
            .then(() => {});
        }
      }),
    );

    // Email notification chauffeur
    if (driverEmail) {
      const driverMail = driverNotifyEmail(booking, driverName);
      emailPromises.push(
        sendEmail(driverEmail, driverMail.subject, driverMail.html, driverMail.text).then((ok) => {
          notifResults.driverEmail = ok;
          if (ok) {
            supa
              .from('bookings')
              .update({
                notifications: {
                  ...booking.notifications,
                  driver_notify_email_sent: true,
                  driver_notify_email_sent_at: new Date().toISOString(),
                },
              })
              .eq('id', booking.id)
              .then(() => {});
          }
        }),
      );
    }

    // Attendre les emails (max 5s)
    await Promise.race([
      Promise.allSettled(emailPromises),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    return res.status(201).json({
      success: true,
      booking_id: booking.id,
      status: 'pending',
      scheduled_at: booking.scheduled_at,
      notifications: notifResults,
      reminders_scheduled: reminders.length,
    });
  } catch (err: any) {
    console.error('[Booking] Create error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/bookings/driver/:driverId — Reservations d'un chauffeur
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/driver/:driverId', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const status = req.query.status as string | undefined;

  try {
    const supa = await getSupa();
    let query = supa
      .from('bookings')
      .select('*')
      .eq('driver_id', driverId)
      .order('scheduled_at', { ascending: false })
      .limit(50);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return res.json({ bookings: data || [] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/bookings/:id — Detail d'une reservation
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const supa = await getSupa();
    const { data, error } = await supa.from('bookings').select('*').eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'Reservation introuvable' });
    return res.json({ booking: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/bookings/:id/confirm — Chauffeur confirme la reservation
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/:id/confirm', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const supa = await getSupa();
    const { data: booking, error } = await supa
      .from('bookings')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .single();

    if (error || !booking) {
      return res.status(400).json({ error: 'Reservation non trouvee ou deja traitee' });
    }

    console.log(`[Booking] Confirmed ${id}`);

    // SMS de confirmation au client
    sendSMS(
      booking.client_phone,
      `FOREAS : Votre reservation du ${formatDateTime(booking.scheduled_at)} est confirmee ! Votre chauffeur vous attend. Depart: ${booking.pickup_address}`,
    ).catch(() => {});

    return res.json({ success: true, booking });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/bookings/:id/cancel — Annulation
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/:id/cancel', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body || {};

  try {
    const supa = await getSupa();

    const { data: booking, error } = await supa
      .from('bookings')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['pending', 'confirmed', 'reminded_2h'])
      .select()
      .single();

    if (error || !booking) {
      return res.status(400).json({ error: 'Reservation non annulable' });
    }

    // Annuler les rappels pending
    await supa
      .from('scheduled_reminders')
      .update({ status: 'cancelled' })
      .eq('booking_id', id)
      .eq('status', 'pending');

    console.log(`[Booking] Cancelled ${id} — reason: ${reason || 'N/A'}`);

    // SMS d'annulation au client
    sendSMS(
      booking.client_phone,
      `FOREAS : Votre reservation du ${formatDateTime(booking.scheduled_at)} a ete annulee. ${reason ? `Raison: ${reason}` : "Contactez votre chauffeur pour plus d'infos."}`,
    ).catch(() => {});

    return res.json({ success: true, booking });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/bookings/process-reminders — CRON endpoint (Railway/Supabase Cron)
// Traite les rappels SMS/push dont l'heure est passee
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/process-reminders', async (req: Request, res: Response) => {
  // Optionnel : proteger avec un secret
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const supa = await getSupa();
    const now = new Date().toISOString();

    // Recuperer les rappels pending dont l'heure est passee
    const { data: reminders, error } = await supa
      .from('scheduled_reminders')
      .select('*, bookings(*)')
      .eq('status', 'pending')
      .lte('scheduled_for', now)
      .limit(50);

    if (error) throw new Error(error.message);
    if (!reminders || reminders.length === 0) {
      return res.json({ processed: 0 });
    }

    console.log(`[Cron] Processing ${reminders.length} pending reminders`);

    let processed = 0;
    let failed = 0;

    for (const reminder of reminders) {
      const booking = reminder.bookings;
      if (!booking || booking.status === 'cancelled') {
        await supa
          .from('scheduled_reminders')
          .update({ status: 'cancelled' })
          .eq('id', reminder.id);
        continue;
      }

      let success = false;
      let errorMsg = '';

      try {
        switch (reminder.reminder_type) {
          case 'client_sms_2h': {
            const time = new Date(booking.scheduled_at).toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit',
            });
            success = await sendSMS(
              booking.client_phone,
              `FOREAS Rappel : Votre trajet est dans 2h !\n${time} - ${booking.pickup_address}\nPrix estime : ${formatPrice(booking.estimated_price)}\nVotre chauffeur se prepare.`,
            );
            if (success) {
              await supa
                .from('bookings')
                .update({
                  status: 'reminded_2h',
                  notifications: {
                    ...booking.notifications,
                    client_sms_2h_sent: true,
                    client_sms_2h_sent_at: now,
                  },
                })
                .eq('id', booking.id);
            }
            break;
          }

          case 'client_sms_15m': {
            success = await sendSMS(
              booking.client_phone,
              `FOREAS : Votre chauffeur arrive dans 15 min !\nRendez-vous : ${booking.pickup_address}\nSoyez pret, il arrive bientot.`,
            );
            if (success) {
              await supa
                .from('bookings')
                .update({
                  status: 'reminded_15m',
                  notifications: {
                    ...booking.notifications,
                    client_sms_15m_sent: true,
                    client_sms_15m_sent_at: now,
                  },
                })
                .eq('id', booking.id);
            }
            break;
          }

          case 'driver_push_1h':
          case 'driver_ajnaya_1h': {
            // Push notification au chauffeur via Supabase + devices table
            const { data: devices } = await supa
              .from('devices')
              .select('push_token')
              .eq('user_id', booking.driver_id)
              .not('push_token', 'is', null);

            if (devices && devices.length > 0) {
              // Envoyer via Expo Push Notifications
              const pushTokens = devices.map((d: any) => d.push_token).filter(Boolean);
              if (pushTokens.length > 0) {
                const time = new Date(booking.scheduled_at).toLocaleTimeString('fr-FR', {
                  hour: '2-digit',
                  minute: '2-digit',
                });
                try {
                  await fetch('https://exp.host/--/api/v2/push/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(
                      pushTokens.map((token: string) => ({
                        to: token,
                        title: '\u23F0 Reservation dans 1h',
                        body: `${booking.pickup_address} \u2192 ${booking.dropoff_address} a ${time}`,
                        data: { type: 'booking_reminder', bookingId: booking.id },
                        sound: 'default',
                        priority: 'high',
                      })),
                    ),
                  });
                  success = true;
                } catch (pushErr: any) {
                  errorMsg = pushErr.message;
                }
              }
            }

            if (success) {
              const notifKey =
                reminder.reminder_type === 'driver_push_1h'
                  ? 'driver_reminder_push_sent'
                  : 'driver_ajnaya_reminder_sent';
              await supa
                .from('bookings')
                .update({
                  notifications: {
                    ...booking.notifications,
                    [notifKey]: true,
                    [`${notifKey}_at`]: now,
                  },
                })
                .eq('id', booking.id);
            }
            break;
          }
        }
      } catch (e: any) {
        errorMsg = e.message;
      }

      // Mettre a jour le statut du rappel
      await supa
        .from('scheduled_reminders')
        .update({
          status: success ? 'sent' : 'failed',
          sent_at: success ? now : null,
          error_message: errorMsg || null,
        })
        .eq('id', reminder.id);

      if (success) processed++;
      else failed++;
    }

    console.log(`[Cron] Done: ${processed} sent, ${failed} failed`);
    return res.json({ processed, failed, total: reminders.length });
  } catch (err: any) {
    console.error('[Cron] Process reminders error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/bookings/upload-photo — Upload photo chauffeur vers Supabase Storage
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/upload-photo', async (req: Request, res: Response) => {
  const { driver_id, base64, mime_type } = req.body || {};

  if (!driver_id || !base64) {
    return res.status(400).json({ error: 'driver_id + base64 requis' });
  }

  try {
    const supa = await getSupa();
    const ext = (mime_type || 'image/jpeg').split('/')[1] || 'jpg';
    const filePath = `${driver_id}/photo.${ext}`;
    const buffer = Buffer.from(base64, 'base64');

    // Upload (upsert) vers le bucket
    const { error: uploadErr } = await supa.storage
      .from('driver-site-photos')
      .upload(filePath, buffer, {
        contentType: mime_type || 'image/jpeg',
        upsert: true,
      });

    if (uploadErr) throw new Error(uploadErr.message);

    // Obtenir l'URL publique
    const { data: urlData } = supa.storage.from('driver-site-photos').getPublicUrl(filePath);

    const publicUrl = urlData?.publicUrl;

    // Mettre a jour le site du chauffeur avec la photo
    await supa.from('driver_sites').update({ photo_url: publicUrl }).eq('driver_id', driver_id);

    console.log(`[Photo] Uploaded for driver ${driver_id}`);
    return res.json({ success: true, photo_url: publicUrl });
  } catch (err: any) {
    console.error('[Photo] Upload error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Geocode Router — /api/geocode
// Utilise l'API Nominatim (OSM) gratuite pour l'autocomplete d'adresses
// ═══════════════════════════════════════════════════════════════════════════════

const geocodeRouter = Router();

geocodeRouter.get('/', async (req: Request, res: Response) => {
  const q = ((req.query.q as string) || '').trim();
  if (!q || q.length < 3) {
    return res.json([]);
  }

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?` +
        `q=${encodeURIComponent(q)}&format=json&limit=5&countrycodes=fr&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'FOREAS-VTC-Booking/1.0',
          'Accept-Language': 'fr',
        },
      },
    );

    if (!response.ok) {
      return res.json([]);
    }

    const data: any[] = await response.json();
    const results = data.map((item: any) => ({
      address: item.display_name,
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon),
      type: item.type,
    }));

    return res.json(results);
  } catch (err: any) {
    console.error('[Geocode] Error:', err.message);
    return res.json([]);
  }
});

export const bookingRouter = router;
export { geocodeRouter };
