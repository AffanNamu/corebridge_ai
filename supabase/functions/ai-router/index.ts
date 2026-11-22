// Supabase Edge Function entry point: ai-router. Logic lives in handler.ts
// so it can be unit-tested without a network or a Firebase project.

import { verifyFirebaseToken } from '../_shared/firebase-auth.ts';
import { handleRequest } from './handler.ts';

Deno.serve((req) => handleRequest(req, { verify: verifyFirebaseToken }));
