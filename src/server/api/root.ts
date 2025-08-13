import { createTRPCRouter } from "@/server/api/trpc";
import { authRouter } from "@/server/api/routers/auth";
import { driverRouter } from "@/server/api/routers/driver";
import { rideRouter } from "@/server/api/routers/ride";
import { bookingRouter } from "@/server/api/routers/booking";
import { earningRouter } from "@/server/api/routers/earning";
import { ajnayaRouter } from "@/server/api/routers/ajnaya";
import { ajnayaFeedbackRouter } from "@/server/api/routers/ajnaya-feedback";
import { stripeRouter } from "@/server/api/routers/stripe";

export const appRouter = createTRPCRouter({
  auth: authRouter,
  driver: driverRouter,
  ride: rideRouter,
  booking: bookingRouter,
  earning: earningRouter,
  ajnaya: ajnayaRouter,
  ajnayaFeedback: ajnayaFeedbackRouter,
  stripe: stripeRouter,
});

export type AppRouter = typeof appRouter;