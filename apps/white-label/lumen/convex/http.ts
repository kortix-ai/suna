import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";
import { stripeWebhook } from "./billing";

const http = httpRouter();
authComponent.registerRoutes(http, createAuth);
// Stripe → Lumen (mode A). 404 when STRIPE_WEBHOOK_SECRET is unset.
http.route({ path: "/stripe/webhook", method: "POST", handler: stripeWebhook });
export default http;
