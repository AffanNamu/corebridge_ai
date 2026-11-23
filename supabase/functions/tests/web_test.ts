// Web search: providers, page reading (with private-address protection),
// when chat turns on web mode, and grounding the answer in the results.

import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1';
import { handleRequest as chat } from '../ai-router/handler.ts';
import { readSseData } from '../_shared/http.ts';
import { assertPublicUrl, htmlToText, readPage, searchQueryFrom, wantsWeb, webSearch } from '../_shared/web.ts';
import { testDb } from './pg.ts';

const pg = { sanitizeResources: false, sanitizeOps: false };
const env = (values: Record<string, string>) => (name: string) => values[name];

Deno.test('web mode turns on when the user asks for online answers', () => {
  for (const text of [
    "Hey, don't use your training model, search online for how to fix this Flutter build error",
    'Search the web for the latest Flutter version',
    'Can you look it up?',
    'google it please',
    'find the fix online and bring it here',
    'What is the current dollar to naira exchange rate today?',
    "What's the latest news about Nigeria's elections?",
    'Not from your training, I want what is online',
  ]) assert(wantsWeb(text), text);
  for (const text of ['Write a poem about the sea', 'Explain recursion', 'Fix this function', 'What is 2+2?']) {
    assert(!wantsWeb(text), text);
  }
});

Deno.test('the search query keeps the request and drops the wrapping', () => {
  assertEquals(searchQueryFrom('Search online for flutter gradle namespace not specified error'), 'flutter gradle namespace not specified error');
  assertEquals(searchQueryFrom("Bro, don't use your training, what is the latest Riverpod version"), 'what is the latest Riverpod version');
  assertEquals(searchQueryFrom('find the fix for "Namespace not specified" online and bring it here'), 'find the fix for "Namespace not specified"');
});

Deno.test('only public web addresses can be read', () => {
  for (const bad of [
    'http://localhost:8080/', 'http://127.0.0.1/', 'http://10.0.0.5/admin', 'http://192.168.1.1/', 'http://172.20.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'http://[::1]/', 'file:///etc/passwd',
    'ftp://example.com/', 'https://example.com:8443/', 'http://user:pass@example.com/', 'http://intranet/',
  ]) assertThrows(() => assertPublicUrl(bad), Error, undefined, bad);
  assertEquals(assertPublicUrl('https://docs.flutter.dev/release').hostname, 'docs.flutter.dev');
});

Deno.test('a redirect to a private address is refused', async () => {
  const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })) as typeof fetch;
  await assertRejects(() => readPage('https://evil.example.com/', { env: env({}), fetchImpl }), Error, 'not a public website');
});

Deno.test('pages become readable text', async () => {
  const html = `<html><head><title>Fix &amp; tips</title><style>.x{}</style><script>alert(1)</script></head>
    <body><nav>menu</nav><main><h1>Gradle fix</h1><p>Add <code>namespace</code> to build.gradle.</p><ul><li>One</li><li>Two</li></ul>
    ${'<p>More detail here.</p>'.repeat(40)}</main><footer>footer</footer></body></html>`;
  const fetchImpl = (async () => new Response(html, { headers: { 'content-type': 'text/html' } })) as typeof fetch;
  const page = await readPage('https://example.com/fix', { env: env({}), fetchImpl });
  assertEquals(page.title, 'Fix & tips');
  assertStringIncludes(page.text, 'Add namespace to build.gradle.');
  assertStringIncludes(page.text, '- One');
  for (const junk of ['alert(1)', 'menu', 'footer', '.x{}']) assert(!page.text.includes(junk), junk);
  assertEquals(htmlToText('<p>a&nbsp;&lt;b&gt;</p>'), 'a <b>');
});

Deno.test('search providers: Tavily, Brave, Serper, then keyless fallbacks', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.startsWith('https://api.tavily.com')) {
      assertEquals(new Headers(init!.headers).get('authorization'), 'Bearer tv-key');
      return Response.json({ results: [{ title: 'T', url: 'https://t.example', content: 'tavily <b>snippet</b>' }] });
    }
    if (url.startsWith('https://api.search.brave.com')) {
      return Response.json({ web: { results: [{ title: 'B', url: 'https://b.example', description: 'brave' }] } });
    }
    if (url.startsWith('https://google.serper.dev')) return Response.json({ organic: [{ title: 'S', link: 'https://s.example', snippet: 'serper' }] });
    if (url.startsWith('https://html.duckduckgo.com')) {
      return new Response('<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fd.example%2Fpage&rut=x">Duck <b>title</b></a> <a class="result__snippet" href="#">duck snippet</a>');
    }
    if (url.startsWith('https://en.wikipedia.org')) return Response.json({ query: { search: [{ title: 'Lagos State', snippet: 'wiki' }] } });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const tavily = await webSearch('q', { env: env({ TAVILY_API_KEY: 'tv-key', BRAVE_SEARCH_API_KEY: 'b' }), fetchImpl });
  assertEquals([tavily.provider, tavily.results[0].snippet], ['tavily', 'tavily snippet']);
  assertEquals((await webSearch('q', { env: env({ BRAVE_SEARCH_API_KEY: 'b' }), fetchImpl })).results[0].url, 'https://b.example');
  assertEquals((await webSearch('q', { env: env({ SERPER_API_KEY: 's' }), fetchImpl })).provider, 'serper');
  const duck = await webSearch('q', { env: env({}), fetchImpl });
  assertEquals(duck.results[0], { title: 'Duck title', url: 'https://d.example/page', snippet: 'duck snippet' });

  const blocked = (async (url: string) =>
    url.startsWith('https://html.duckduckgo.com') ? new Response('challenge', { status: 202 }) : await fetchImpl(url)) as typeof fetch;
  const wiki = await webSearch('q', { env: env({}), fetchImpl: blocked });
  assertEquals([wiki.provider, wiki.results[0].url], ['wikipedia', 'https://en.wikipedia.org/wiki/Lagos_State']);
});

/** Tavily + one readable page + the ARO model server. */
function webWorld() {
  const modelBodies: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://api.tavily.com')) {
      return Response.json({ results: [
        { title: 'Flutter 4.2 released', url: 'https://news.example/flutter', content: 'Flutter 4.2 is out.' },
        { title: 'Release notes', url: 'https://docs.example/notes', content: 'Notes.' },
      ] });
    }
    if (url === 'https://news.example/flutter') {
      return new Response('<html><title>Flutter 4.2</title><body><p>Flutter 4.2 was released on 20 November.</p></body></html>', { headers: { 'content-type': 'text/html' } });
    }
    if (url === 'https://docs.example/notes') return new Response('nope', { status: 404 });
    modelBodies.push(JSON.parse(String(init!.body)));
    const body = [
      { choices: [{ delta: { content: 'The latest is Flutter 4.2 [1].' } }] },
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } },
    ].map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return { fetchImpl, modelBodies };
}

async function frames(response: Response): Promise<any[]> {
  const out: any[] = [];
  for await (const p of readSseData(response.body!)) if (p !== '[DONE]') out.push(JSON.parse(p));
  return out;
}

Deno.test({ name: 'chat answers from live web results and lists its sources', ...pg, fn: async () => {
  const world = webWorld();
  const res = await chat(new Request('http://x/ai-router', {
    method: 'POST',
    body: JSON.stringify({ provider: 'aro', model: 'aro-1.5', messages: [{ role: 'user', content: "Don't use your training — search online: what's the latest Flutter version?" }] }),
  }), {
    verify: () => Promise.resolve({ uid: 'user-1' }),
    db: await testDb(),
    fetchImpl: world.fetchImpl,
    env: env({ ARO_MODEL_BASE_URL: 'https://aro.example/v1', TAVILY_API_KEY: 'tv' }),
  });
  const out = await frames(res);
  assertEquals(out[0].status, 'Searching the web…');
  assertEquals(out[1].web.sources.length, 2);
  const meta = out.find((f) => f.meta).meta;
  assertEquals(meta.web.provider, 'tavily');

  const sent = world.modelBodies[0].messages;
  assertEquals(sent.filter((m: any) => m.role === 'system').length, 1, 'web results merged into the one system prompt');
  const webBlock = sent.find((m: any) => m.role === 'system' && m.content.includes('live web search results')).content;
  assertStringIncludes(webBlock, 'Flutter 4.2 was released on 20 November.'); // read from the page itself
  assertStringIncludes(webBlock, '[2] Release notes'); // unreadable page: snippet kept
  assertEquals(sent[0].content.includes('ARO 1.5'), true, 'ARO system prompt stays first');

  const text = out.filter((f) => f.delta).map((f) => f.delta).join('');
  assertStringIncludes(text, 'Flutter 4.2 [1].');
  assertStringIncludes(text, '**Sources**\n1. [Flutter 4.2 released](https://news.example/flutter)');
} });

Deno.test({ name: 'the Web toggle forces a search; when search fails the model says so', ...pg, fn: async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://api.tavily.com')) return new Response('down', { status: 500 });
    bodies.push(JSON.parse(String(init!.body)));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;
  const out = await frames(await chat(new Request('http://x/ai-router', {
    method: 'POST',
    body: JSON.stringify({ provider: 'aro', model: 'aro-1.5', webSearch: true, messages: [{ role: 'user', content: 'Explain recursion' }] }),
  }), {
    verify: () => Promise.resolve({ uid: 'user-1' }), db: await testDb(), fetchImpl,
    env: env({ ARO_MODEL_BASE_URL: 'https://aro.example/v1', TAVILY_API_KEY: 'tv' }),
  }));
  assertEquals(out[1].status, "Couldn't reach the web");
  assert(bodies[0].messages.some((m: any) => m.role === 'system' && m.content.includes('web search failed')));
  assert(!out.some((f) => f.delta?.includes('Sources')));
} });

Deno.test('the coding agent can search the web and read pages', async () => {
  const { handleRequest: agent } = await import('../aro-agent/handler.ts');
  let turn = 0;
  const toolResults: string[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.github.com') {
      if (url.pathname === '/repos/acme/app') return Response.json({ default_branch: 'main', permissions: { push: true } });
      return Response.json({ object: { sha: 'c0' } });
    }
    if (url.hostname === 'api.tavily.com') return Response.json({ results: [{ title: 'Gradle namespace fix', url: 'https://so.example/q/1', content: 'Add namespace' }] });
    if (url.hostname === 'so.example') return new Response('<p>Set namespace "com.example.app" in android/app/build.gradle.</p>', { headers: { 'content-type': 'text/html' } });
    const body = JSON.parse(String(init.body));
    for (const m of body.messages) if (m.role === 'tool') toolResults.push(m.content);
    const calls = [
      [{ name: 'web_search', args: { query: 'gradle namespace not specified' } }],
      [{ name: 'read_webpage', args: { url: 'https://so.example/q/1' } }],
    ][turn++];
    return Response.json({ choices: [{ message: {
      role: 'assistant', content: calls ? null : 'Found it: set namespace (source: https://so.example/q/1).',
      tool_calls: (calls ?? []).map((c, i) => ({ id: `c${turn}${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    } }] });
  }) as typeof fetch;

  const out = await frames(await agent(new Request('http://x/aro-agent', {
    method: 'POST',
    body: JSON.stringify({ provider: 'openai', model: 'gpt-test', apiKey: 'sk', githubToken: 'github_pat_x', repo: { owner: 'acme', name: 'app' }, message: 'Search online for a fix to the gradle namespace error' }),
  }), { verify: () => Promise.resolve({ uid: 'u1' }), fetchImpl, env: env({ TAVILY_API_KEY: 'tv' }), db: null }));
  assertEquals(out.filter((e) => e.type === 'tool').map((e) => e.name), ['web_search', 'read_webpage']);
  assertStringIncludes(toolResults.join('\n'), 'Gradle namespace fix');
  assertStringIncludes(toolResults.join('\n'), 'Set namespace "com.example.app" in android/app/build.gradle.');
  assertEquals(out.at(-1), { type: 'done', status: 'completed' });
});
