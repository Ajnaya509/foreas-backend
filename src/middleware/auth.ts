import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { getUserIdByEmail } from '../services/supa.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key';
const DEV_MODE = process.env.DEV_MODE === 'true';
const DEV_TEST_EMAIL = process.env.DEV_TEST_EMAIL || 'test@foreas.app';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        userId: string;
        email?: string;
        phoneNumber?: string;
        isPremium: boolean;
      };
    }
  }
}

export async function requireUser(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req.headers.authorization;

    // Dev mode: allow x-user-email header for testing
    if (DEV_MODE && !auth) {
      const email = String(req.headers['x-user-email'] || DEV_TEST_EMAIL);
      console.log(`🔓 Dev mode: using email ${email}`);
      try {
        const userId = await getUserIdByEmail(email);
        req.user = {
          id: userId,
          userId: userId,
          email,
          isPremium: false,
        };
        return next();
      } catch (error) {
        console.error('Dev mode user creation failed:', error);
        return res.status(500).json({ error: 'Dev mode user setup failed' });
      }
    }

    // Production mode: require JWT
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization token required' });
    }

    const token = auth.slice(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;

      if (decoded.userId) {
        req.user = {
          id: decoded.userId,
          userId: decoded.userId,
          phoneNumber: decoded.phoneNumber,
          isPremium: decoded.isPremium || false,
          email: decoded.email,
        };
      } else if (decoded.email) {
        req.user = {
          id: decoded.userId || decoded.id,
          userId: decoded.userId || decoded.id,
          email: decoded.email,
          isPremium: false,
        };
      } else {
        return res.status(401).json({ error: 'Invalid token payload' });
      }

      next();
    } catch (jwtError) {
      console.error('JWT verification failed:', jwtError);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

export function generateJWT(userId: string, email?: string): string {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '7d' });
}
