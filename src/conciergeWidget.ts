/**
 * conciergeWidget.ts — Widget Ajnaya pour sites perso chauffeurs
 * ════════════════════════════════════════════════════════════════════════
 * Sprint Activation Conciergerie 30 avril 2026.
 *
 * Renvoie le HTML/CSS/JS auto-contenu d'un widget chat à injecter en bas
 * de page du site perso de chaque chauffeur. Le widget :
 *
 *   1. Affiche une bulle flottante en bas à droite (avec halo pulse)
 *   2. Au tap, ouvre un panel de chat plein écran sur mobile, 380×600 desktop
 *   3. Discute via POST /api/concierge/:slug/chat (Pieuvre tentacle 'concierge_personnel')
 *   4. Track chaque event funnel via POST /api/concierge/:slug/track-event
 *   5. À la fin du flow booking, affiche le lien de paiement Stripe inline
 *      (PAS d'envoi SMS/email externe pour éviter friction — fix demandé 30/04)
 *
 * Vanilla JS uniquement (pas de framework, pas de bundler) pour rester
 * léger (~12KB) et fonctionner sur n'importe quel site statique.
 */

export interface ConciergeWidgetOptions {
  /** Slug du chauffeur dans driver_sites.slug */
  driverSlug: string;
  /** Nom affiché du chauffeur (display_name) */
  driverName: string;
  /** URL backend qui héberge les endpoints /api/concierge/* */
  apiBaseUrl: string;
  /** Couleur primaire (généralement violet FOREAS) */
  primaryColor?: string;
  /** Couleur secondaire (généralement cyan FOREAS) */
  accentColor?: string;
}

export function renderConciergeWidget(opts: ConciergeWidgetOptions): string {
  const {
    driverSlug,
    driverName,
    apiBaseUrl,
    primaryColor = '#8C52FF',
    accentColor = '#00D4FF',
  } = opts;

  // Échappement basique pour insertion dans JS string
  const safeName = driverName.replace(/['"\\<>]/g, '');
  const safeSlug = driverSlug.replace(/[^a-z0-9-]/gi, '');
  const safeApi = apiBaseUrl.replace(/['"<>]/g, '');

  return `
<!-- ════════════════════════════════════════════════════════════════════ -->
<!-- ✨ Ajnaya Concierge Widget — FOREAS                                   -->
<!-- ════════════════════════════════════════════════════════════════════ -->
<style>
  #foreas-concierge-widget,
  #foreas-concierge-widget * {
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  #foreas-concierge-widget {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
  }
  #foreas-concierge-widget .fcw-bubble {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: linear-gradient(135deg, ${primaryColor} 0%, ${accentColor} 100%);
    box-shadow: 0 8px 32px rgba(140, 82, 255, 0.45), 0 4px 12px rgba(0,0,0,0.2);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s;
    animation: fcw-pulse 2.4s infinite ease-in-out;
  }
  #foreas-concierge-widget .fcw-bubble:hover {
    transform: scale(1.08);
    box-shadow: 0 12px 40px rgba(140, 82, 255, 0.6), 0 6px 16px rgba(0,0,0,0.25);
  }
  @keyframes fcw-pulse {
    0%, 100% { box-shadow: 0 8px 32px rgba(140, 82, 255, 0.45), 0 0 0 0 rgba(140, 82, 255, 0.4); }
    50%      { box-shadow: 0 8px 32px rgba(140, 82, 255, 0.45), 0 0 0 14px rgba(140, 82, 255, 0); }
  }
  #foreas-concierge-widget .fcw-bubble svg { width: 28px; height: 28px; fill: white; }
  #foreas-concierge-widget .fcw-badge {
    position: absolute;
    top: -2px; right: -2px;
    background: #EF4444;
    color: white;
    font-size: 11px;
    font-weight: 800;
    padding: 2px 6px;
    border-radius: 10px;
    border: 2px solid white;
    display: none;
  }

  #foreas-concierge-widget .fcw-panel {
    position: fixed;
    bottom: 100px;
    right: 20px;
    width: 380px;
    max-width: calc(100vw - 40px);
    height: 600px;
    max-height: calc(100vh - 140px);
    background: #0B0F1E;
    border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.3);
    display: none;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    transform: translateY(20px);
    opacity: 0;
    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s;
  }
  #foreas-concierge-widget.open .fcw-panel {
    display: flex;
    transform: translateY(0);
    opacity: 1;
  }
  @media (max-width: 480px) {
    #foreas-concierge-widget .fcw-panel {
      bottom: 0; right: 0; left: 0;
      width: 100%;
      max-width: 100%;
      height: 100vh;
      max-height: 100vh;
      border-radius: 20px 20px 0 0;
    }
  }

  #foreas-concierge-widget .fcw-header {
    background: linear-gradient(135deg, ${primaryColor} 0%, ${accentColor} 100%);
    padding: 16px 20px;
    color: white;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  #foreas-concierge-widget .fcw-avatar {
    width: 36px; height: 36px;
    border-radius: 50%;
    background: rgba(255,255,255,0.2);
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }
  #foreas-concierge-widget .fcw-title { font-size: 15px; font-weight: 700; line-height: 1.2; }
  #foreas-concierge-widget .fcw-subtitle { font-size: 12px; opacity: 0.85; line-height: 1.3; margin-top: 2px; }
  #foreas-concierge-widget .fcw-close {
    margin-left: auto;
    width: 28px; height: 28px;
    border-radius: 50%;
    background: rgba(255,255,255,0.15);
    border: none;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    color: white;
    font-size: 18px;
    line-height: 1;
  }
  #foreas-concierge-widget .fcw-close:hover { background: rgba(255,255,255,0.25); }

  #foreas-concierge-widget .fcw-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: linear-gradient(180deg, #0B0F1E 0%, #070A14 100%);
    scroll-behavior: smooth;
  }
  #foreas-concierge-widget .fcw-msg {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.45;
    word-wrap: break-word;
    animation: fcw-msg-in 0.3s ease-out;
  }
  @keyframes fcw-msg-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  #foreas-concierge-widget .fcw-msg.assistant {
    align-self: flex-start;
    background: rgba(140, 82, 255, 0.12);
    border: 1px solid rgba(140, 82, 255, 0.2);
    color: white;
    border-bottom-left-radius: 4px;
  }
  #foreas-concierge-widget .fcw-msg.user {
    align-self: flex-end;
    background: linear-gradient(135deg, ${primaryColor}, ${accentColor});
    color: white;
    border-bottom-right-radius: 4px;
  }
  #foreas-concierge-widget .fcw-msg.system {
    align-self: center;
    background: rgba(34, 197, 94, 0.12);
    border: 1px solid rgba(34, 197, 94, 0.25);
    color: #34D399;
    font-size: 12px;
    text-align: center;
    max-width: 95%;
  }
  #foreas-concierge-widget .fcw-typing {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 14px;
    background: rgba(140, 82, 255, 0.12);
    border-radius: 14px;
  }
  #foreas-concierge-widget .fcw-typing span {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: ${accentColor};
    animation: fcw-typing 1.2s infinite;
  }
  #foreas-concierge-widget .fcw-typing span:nth-child(2) { animation-delay: 0.2s; }
  #foreas-concierge-widget .fcw-typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes fcw-typing {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-4px); }
  }

  #foreas-concierge-widget .fcw-pay-card {
    align-self: stretch;
    background: linear-gradient(135deg, rgba(34,197,94,0.08), rgba(34,197,94,0.04));
    border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 14px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  #foreas-concierge-widget .fcw-pay-amount {
    font-size: 26px;
    font-weight: 800;
    color: #22C55E;
    text-align: center;
  }
  #foreas-concierge-widget .fcw-pay-button {
    background: linear-gradient(135deg, #22C55E, #10B981);
    color: white;
    padding: 12px;
    border-radius: 10px;
    text-align: center;
    font-weight: 700;
    font-size: 14px;
    text-decoration: none;
    cursor: pointer;
    border: none;
    width: 100%;
  }
  #foreas-concierge-widget .fcw-pay-button:hover { opacity: 0.92; }

  #foreas-concierge-widget .fcw-input-wrap {
    border-top: 1px solid rgba(255,255,255,0.08);
    padding: 12px;
    background: #0B0F1E;
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  #foreas-concierge-widget .fcw-input {
    flex: 1;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 10px 14px;
    color: white;
    font-size: 14px;
    outline: none;
    resize: none;
    min-height: 40px;
    max-height: 100px;
    line-height: 1.4;
    font-family: inherit;
  }
  #foreas-concierge-widget .fcw-input:focus {
    border-color: ${primaryColor};
    background: rgba(140, 82, 255, 0.06);
  }
  #foreas-concierge-widget .fcw-send {
    width: 40px; height: 40px;
    border-radius: 50%;
    background: linear-gradient(135deg, ${primaryColor}, ${accentColor});
    color: white;
    border: none;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: opacity 0.2s, transform 0.15s;
  }
  #foreas-concierge-widget .fcw-send:hover { opacity: 0.92; transform: scale(1.05); }
  #foreas-concierge-widget .fcw-send:disabled { opacity: 0.4; cursor: not-allowed; }
  #foreas-concierge-widget .fcw-send svg { width: 18px; height: 18px; fill: white; }

  #foreas-concierge-widget .fcw-footer {
    padding: 6px 12px;
    text-align: center;
    font-size: 10px;
    color: rgba(255,255,255,0.3);
    background: #0B0F1E;
  }
</style>

<div id="foreas-concierge-widget">
  <!-- Floating bubble -->
  <div class="fcw-bubble" onclick="window.foreasConcierge && window.foreasConcierge.toggle()">
    <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
    <div class="fcw-badge">1</div>
  </div>

  <!-- Chat panel -->
  <div class="fcw-panel">
    <div class="fcw-header">
      <div class="fcw-avatar">✨</div>
      <div>
        <div class="fcw-title">Ajnaya</div>
        <div class="fcw-subtitle">Concierge de ${safeName}</div>
      </div>
      <button class="fcw-close" onclick="window.foreasConcierge && window.foreasConcierge.toggle()" aria-label="Fermer">×</button>
    </div>
    <div class="fcw-messages" id="fcw-messages-list"></div>
    <div class="fcw-input-wrap">
      <textarea
        class="fcw-input"
        id="fcw-input-text"
        placeholder="Écris ton message..."
        rows="1"
        onkeydown="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();window.foreasConcierge.send();}"
      ></textarea>
      <button class="fcw-send" id="fcw-send-btn" onclick="window.foreasConcierge.send()" aria-label="Envoyer">
        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
    <div class="fcw-footer">Propulsé par FOREAS · IA Ajnaya</div>
  </div>
</div>

<script>
(function() {
  var SLUG = '${safeSlug}';
  var DRIVER_NAME = '${safeName}';
  var API = '${safeApi}';
  var sessionId = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  var conversationStarted = false;
  var openedTracked = false;
  var messages = [];
  var booking = null;

  function el(id) { return document.getElementById(id); }
  function $msgs() { return el('fcw-messages-list'); }
  function widget() { return el('foreas-concierge-widget'); }

  function trackEvent(eventType, meta) {
    fetch(API + '/api/concierge/' + SLUG + '/track-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: eventType,
        session_id: sessionId,
        meta: meta || {}
      })
    }).catch(function(){});
  }

  function addMsg(role, text, opts) {
    var div = document.createElement('div');
    div.className = 'fcw-msg ' + role;
    div.textContent = text;
    if (opts && opts.html) {
      div.innerHTML = '';
      div.appendChild(opts.html);
    }
    $msgs().appendChild(div);
    $msgs().scrollTop = $msgs().scrollHeight;
    return div;
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'fcw-typing';
    div.id = 'fcw-typing-indicator';
    div.innerHTML = '<span></span><span></span><span></span>';
    $msgs().appendChild(div);
    $msgs().scrollTop = $msgs().scrollHeight;
  }
  function hideTyping() {
    var t = el('fcw-typing-indicator');
    if (t) t.remove();
  }

  function renderPaymentCard(amount, paymentUrl) {
    var card = document.createElement('div');
    card.className = 'fcw-pay-card';

    var label = document.createElement('div');
    label.style.color = 'rgba(255,255,255,0.7)';
    label.style.fontSize = '12px';
    label.style.textAlign = 'center';
    label.textContent = '💳 Confirme ta réservation en payant';
    card.appendChild(label);

    var amountEl = document.createElement('div');
    amountEl.className = 'fcw-pay-amount';
    amountEl.textContent = (Math.round(amount * 100) / 100).toFixed(2) + ' €';
    card.appendChild(amountEl);

    var btn = document.createElement('a');
    btn.className = 'fcw-pay-button';
    btn.href = paymentUrl;
    btn.target = '_blank';
    btn.rel = 'noopener';
    btn.textContent = 'Payer ' + (Math.round(amount * 100) / 100).toFixed(2) + ' €';
    btn.onclick = function() { trackEvent('payment_link_clicked', { booking_id: booking && booking.id }); };
    card.appendChild(btn);

    var note = document.createElement('div');
    note.style.color = 'rgba(255,255,255,0.4)';
    note.style.fontSize = '11px';
    note.style.textAlign = 'center';
    note.textContent = 'Paiement sécurisé Stripe · Reçu par email';
    card.appendChild(note);

    addMsg('assistant', '', { html: card });
  }

  async function sendToBackend(text) {
    showTyping();
    try {
      var res = await fetch(API + '/api/concierge/' + SLUG + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          session_id: sessionId,
          history: messages.slice(-10)
        })
      });
      var data = await res.json();
      hideTyping();

      var reply = data.text || data.content || data.response || data.reply || '';
      if (reply) {
        addMsg('assistant', reply);
        messages.push({ role: 'user', content: text });
        messages.push({ role: 'assistant', content: reply });
      }

      // Si Ajnaya signale un booking confirmé → afficher le payment-link
      if (data.booking && data.booking.payment_url) {
        booking = data.booking;
        renderPaymentCard(data.booking.estimated_price, data.booking.payment_url);
        trackEvent('payment_link_sent', { booking_id: data.booking.id });
      }
      if (data.event_type) {
        trackEvent(data.event_type, data.event_meta || {});
      }
    } catch (err) {
      hideTyping();
      addMsg('assistant', 'Hmm, problème de réseau. Réessaie dans 10 secondes ?');
    }
  }

  function send() {
    var input = el('fcw-input-text');
    var text = (input.value || '').trim();
    if (!text) return;
    addMsg('user', text);
    input.value = '';
    if (!conversationStarted) {
      trackEvent('first_message_sent', { text_length: text.length });
      conversationStarted = true;
    }
    sendToBackend(text);
  }

  function toggle() {
    var w = widget();
    var isOpen = w.classList.toggle('open');
    if (isOpen && !openedTracked) {
      trackEvent('widget_opened', { ua: navigator.userAgent.substring(0, 100) });
      openedTracked = true;
      // Premier message d'accueil
      setTimeout(function() {
        addMsg('assistant', "Bonjour ! Je suis Ajnaya, je gère les réservations de " + DRIVER_NAME + ". Vous voulez aller où, et quand ?");
      }, 350);
      // Focus l'input après l'animation d'ouverture
      setTimeout(function() { el('fcw-input-text').focus(); }, 500);
    }
  }

  window.foreasConcierge = { send: send, toggle: toggle, track: trackEvent };
})();
</script>
<!-- ════════════════════════════════════════════════════════════════════ -->
`;
}
