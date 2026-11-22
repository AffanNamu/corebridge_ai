// Firestore rules tests. Run with: cd firestore && npm install && npm test
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { addDoc, collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-aro-ai',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});

after(async () => env?.cleanup());
beforeEach(async () => env.clearFirestore());

const alice = () => env.authenticatedContext('alice').firestore();
const bob = () => env.authenticatedContext('bob').firestore();
const anon = () => env.unauthenticatedContext().firestore();

async function seed(path, data) {
  await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), path), data));
}

test('users can only read and write their own profile (API keys, GitHub token)', async () => {
  await seed('users/alice', { apiKeys: { github: 'github_pat_secret' } });
  await assertSucceeds(getDoc(doc(alice(), 'users/alice')));
  await assertSucceeds(setDoc(doc(alice(), 'users/alice'), { trainingConsent: true }, { merge: true }));
  await assertFails(getDoc(doc(bob(), 'users/alice')));
  await assertFails(setDoc(doc(bob(), 'users/alice'), { apiKeys: {} }));
  await assertFails(getDoc(doc(anon(), 'users/alice')));
  await assertFails(getDocs(collection(alice(), 'users')));
});

test('conversations and messages are private to their owner', async () => {
  await seed('conversations/c1', { ownerId: 'alice', title: 'hi', updatedAt: 1 });
  await seed('conversations/c1/items/m1', { role: 'assistant', content: 'yo', servedBy: 'aro' });

  await assertSucceeds(getDocs(query(collection(alice(), 'conversations'), where('ownerId', '==', 'alice'))));
  await assertFails(getDocs(query(collection(bob(), 'conversations'), where('ownerId', '==', 'alice'))));
  await assertFails(getDocs(collection(bob(), 'conversations')));

  await assertSucceeds(getDoc(doc(alice(), 'conversations/c1/items/m1')));
  await assertSucceeds(updateDoc(doc(alice(), 'conversations/c1/items/m1'), { rating: -1, correction: 'better' }));
  await assertFails(getDoc(doc(bob(), 'conversations/c1/items/m1')));
  await assertFails(addDoc(collection(bob(), 'conversations/c1/items'), { role: 'user', content: 'injected' }));
});

test('you cannot create data for someone else or steal ownership', async () => {
  await assertSucceeds(addDoc(collection(alice(), 'conversations'), { ownerId: 'alice', title: 't' }));
  await assertFails(addDoc(collection(alice(), 'conversations'), { ownerId: 'bob', title: 't' }));

  await seed('agentSessions/s1', { ownerId: 'alice', repoFullName: 'acme/app', updatedAt: 1 });
  await assertSucceeds(updateDoc(doc(alice(), 'agentSessions/s1'), { status: 'paused' }));
  await assertFails(updateDoc(doc(alice(), 'agentSessions/s1'), { ownerId: 'bob' }));
  await assertFails(getDoc(doc(bob(), 'agentSessions/s1')));
});

test('artifacts, versions, files and projects follow the same ownership', async () => {
  await seed('artifacts/a1', { ownerId: 'alice' });
  await seed('artifacts/a1/versions/v1', { content: 'x' });
  await seed('files/f1', { ownerId: 'alice' });
  await seed('projects/p1', { ownerId: 'alice' });

  for (const path of ['artifacts/a1', 'artifacts/a1/versions/v1', 'files/f1', 'projects/p1']) {
    await assertSucceeds(getDoc(doc(alice(), path)));
    await assertFails(getDoc(doc(bob(), path)));
  }
});

test('unknown collections are closed', async () => {
  await assertFails(setDoc(doc(alice(), 'admin/config'), { x: 1 }));
  await assertFails(getDoc(doc(alice(), 'trainingExports/latest')));
});
