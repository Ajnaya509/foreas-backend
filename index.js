const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(
  '/api/webhooks/stripe',
  bodyParser.raw({ type: 'application/json' })
);

app.post('/api/webhooks/stripe', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️  Erreur de vérification webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    console.log('Paiement réussi', paymentIntent.id);
  }

  res.json({ received: true });
});

app.get('/', (req, res) => {
  res.send('FOREAS Stripe Backend is running');
});

app.get('/health', (req, res) => {
  res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur en écoute sur le port ${PORT}`));