import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import bodyParser from 'body-parser';

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const stripe = new Stripe(process.env['STRIPE_SECRET_KEY'] as string, { apiVersion: '2023-10-16' });

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { email } = req.body;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: process.env['PRICE_ID'] as string, quantity: 1 }],
      success_url: process.env['SUCCESS_URL'] as string,
      cancel_url: process.env['CANCEL_URL'] as string,
      allow_promotion_codes: true,
      subscription_data: {
        trial_period_days: 3
      }
    });
    res.json({ url: session.url });
  } catch (e:any) {
    res.status(400).json({ error: e.message });
  }
});

// Webhook endpoint for Stripe events
app.post('/api/webhooks/stripe', bodyParser.raw({type: 'application/json'}), (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  const endpointSecret = process.env['STRIPE_WEBHOOK_SECRET'] as string;
  
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err:any) {
    console.log('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      console.log('Payment successful!', event.data.object);
      break;
    case 'invoice.payment_succeeded':
      console.log('Invoice paid!', event.data.object);
      break;
    case 'payment_intent.succeeded':
      console.log('Payment intent succeeded!', event.data.object);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({received: true});
});

app.get('/health',(_,res)=>res.json({ok:true}));

const port = process.env['PORT'] || 4242;
app.listen(port, ()=>console.log('Stripe backend on', port));