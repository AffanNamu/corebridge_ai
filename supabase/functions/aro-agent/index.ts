// Supabase Edge Function entry point: aro-agent (GitHub coding agent).
// Logic lives in handler.ts so it can be unit-tested offline.

import { verifyFirebaseToken } from '../_shared/firebase-auth.ts';
import { handleRequest } from './handler.ts';

Deno.serve((req) => handleRequest(req, { verify: verifyFirebaseToken }));
