// Supabase Edge Function entry point: aro-admin (admin dashboard API).

import { verifyFirebaseToken } from '../_shared/firebase-auth.ts';
import { handleRequest } from './handler.ts';

Deno.serve((req) => handleRequest(req, { verify: verifyFirebaseToken }));
