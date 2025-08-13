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

app.get('/health',(_,res)=>res.json({ok:true}));

const port = process.env['PORT'] || 4242;
app.listen(port, ()=>console.log('Stripe backend on', port));