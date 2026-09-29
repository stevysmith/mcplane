import { connect } from 'node:tls';
import { McpClient } from '../mcp-client.js';
import type { Check, Tool } from '../types.js';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

/** Connects the way a store's scanner does and returns the tool list for the other checks. */
export async function serverChecks(url: string, auth: 'none' | 'oauth', token?: string): Promise<{ checks: Check[]; tools: Tool[] }> {
  const checks: Check[] = [];
  const bearer: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const client = new McpClient(url, bearer);
  let tools: Tool[] = [];

  // initialize
  let init;
  try {
    init = await client.initialize();
  } catch (e) {
    checks.push({ id: 'server.reachable', level: 'fail', title: 'Server answers', detail: String((e as Error).message), fix: `Check ${url} is live and reachable from the public internet.` });
    return { checks, tools };
  }
  if (auth === 'oauth' && init.status === 401) {
    checks.push({ id: 'server.reachable', level: 'pass', title: 'Server answers (401 until signed in, as expected)' });
    if (token) checks.push({ id: 'server.token', level: 'fail', title: 'The --token signs in', detail: 'still 401', fix: 'Pass a valid access token for your own account.' });
    else checks.push({ id: 'server.tools-skipped', level: 'skip', title: 'Tool checks skipped: the server needs sign-in', fix: 'Run again with --token <access token> from your own account to check tool titles, annotations and descriptions.' });
  } else if (init.status >= 400 || init.body?.error) {
    checks.push({
      id: 'server.initialize',
      level: 'fail',
      title: 'initialize succeeds',
      detail: `HTTP ${init.status}${init.body?.error ? `, ${JSON.stringify(init.body.error).slice(0, 160)}` : ''}`,
      fix: auth === 'none' ? 'An authless server must answer initialize without credentials. If it needs sign-in, set "auth": "oauth" in mcplane.json.' : undefined,
    });
    return { checks, tools };
  } else {
    const info = init.body?.result?.serverInfo;
    checks.push({ id: 'server.initialize', level: 'pass', title: 'initialize succeeds', detail: info ? `${info.name ?? ''} ${info.version ?? ''}`.trim() : undefined });
  }

  if (auth === 'none' || (token && init.status < 300)) {
    const list = await client.request('tools/list').catch(() => null);
    tools = list?.body?.result?.tools ?? [];
    checks.push(
      tools.length
        ? { id: 'server.tools', level: 'pass', title: 'tools/list returns tools', detail: tools.map((t) => t.name).join(', ') }
        : { id: 'server.tools', level: 'fail', title: 'tools/list returns tools', detail: `HTTP ${list?.status ?? 'error'}`, fix: 'Stores scan tools/list; with no tools there is nothing to list.' },
    );

    const ping = await client.request('ping').catch(() => null);
    checks.push({
      id: 'server.ping',
      level: ping && ping.status < 300 && !ping.body?.error ? 'pass' : 'warn',
      title: 'ping answers',
      fix: 'Answer "ping" with an empty result; some clients use it for health checks.',
    });

    // OpenAI's scanner probes optional methods and treats a 500 / -32603 as a crash.
    const probe = await client.request('server/discover').catch(() => null);
    const code = probe?.body?.error?.code;
    // Any other JSON-RPC error at HTTP 200 is survivable; a 5xx, -32603 or no JSON-RPC answer is not.
    const survivable = probe?.status === 200 && typeof code === 'number' && code !== -32603;
    checks.push(
      probe && probe.status === 200 && code === -32601
        ? { id: 'server.unknown-method', level: 'pass', title: 'Unknown methods return -32601 (method not found)' }
        : {
            id: 'server.unknown-method',
            level: survivable ? 'warn' : 'fail',
            title: 'Unknown methods return -32601 (method not found)',
            detail: `server/discover got HTTP ${probe?.status ?? 'error'}${code !== undefined ? `, code ${code}` : ''}`,
            fix: "Return JSON-RPC error -32601 at HTTP 200 for methods you don't implement. OpenAI's tool scan probes server/discover and aborts on a 500 or -32603.",
            stores: ['chatgpt'],
          },
    );

    const note = await client.request('notifications/initialized', undefined, { notification: true }).catch(() => null);
    checks.push({
      id: 'server.notifications',
      level: note && (note.status === 202 || note.status === 200 || note.status === 204) ? 'pass' : 'warn',
      title: 'Notifications are accepted',
      detail: note ? `HTTP ${note.status}` : 'no answer',
      fix: 'Reply 202 Accepted to JSON-RPC notifications (messages with no id).',
    });

    const slash = await new McpClient(url.replace(/\/?$/, '/'), bearer).request('tools/list').catch(() => null);
    checks.push({
      id: 'server.trailing-slash',
      level: slash && slash.status < 400 ? 'pass' : 'warn',
      title: 'The URL with a trailing slash works too',
      detail: slash ? `HTTP ${slash.status}` : 'no answer',
      fix: 'Accept /mcp/ as well as /mcp. Reviewers paste URLs by hand, and a 404 reads as "unable to connect".',
    });
  }

  // CORS preflight, as a browser-based connector would send it.
  const pre = await fetch(url, {
    method: 'OPTIONS',
    headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, mcp-protocol-version, authorization' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const allow = pre?.headers.get('access-control-allow-origin');
  checks.push({
    id: 'server.cors',
    level: pre && pre.status < 300 && allow ? 'pass' : 'warn',
    title: 'CORS preflight answers',
    detail: pre ? `HTTP ${pre.status}, allow-origin ${allow ?? 'missing'}` : 'no answer',
    fix: 'Answer OPTIONS on the MCP endpoint with 204 and Access-Control-Allow-Origin/-Headers (content-type, mcp-protocol-version, mcp-session-id, authorization).',
  });

  // Filtering by user agent: a scanner and a browser should get the same status.
  const asBrowser = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }).catch(() => null);
  const asBot = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'python-requests/2.32' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }).catch(() => null);
  if (asBrowser && asBot) {
    const blocked = asBot.status === 403 && asBrowser.status !== 403;
    checks.push({
      id: 'server.bot-filter',
      level: blocked ? 'fail' : asBot.status === 403 ? 'warn' : 'pass',
      title: 'Automated clients are not blocked',
      detail: `browser UA ${asBrowser.status}, script UA ${asBot.status}`,
      fix: 'A firewall or bot rule is returning 403 to non-browser clients. Store scanners and reviewers are automated; allow them on the MCP path.',
    });
  }

  checks.push(await tls12Check(url));
  checks.push(await echCheck(url));
  return { checks, tools };
}

/** Some review networks only speak TLS 1.2. */
function tls12Check(url: string): Promise<Check> {
  const host = new URL(url).hostname;
  return new Promise((resolve) => {
    const sock = connect({ host, port: 443, servername: host, maxVersion: 'TLSv1.2', timeout: 8000 }, () => {
      sock.end();
      resolve({ id: 'server.tls12', level: 'pass', title: 'A TLS 1.2 client can connect' });
    });
    const bad = (why: string) =>
      resolve({ id: 'server.tls12', level: 'warn', title: 'A TLS 1.2 client can connect', detail: why, fix: 'Allow TLS 1.2; some corporate and review proxies cannot do TLS 1.3.' });
    sock.on('error', (e) => bad(e.message));
    sock.on('timeout', () => {
      sock.destroy();
      bad('timed out');
    });
  });
}

/** Encrypted ClientHello in DNS makes TLS-inspecting proxies reset the connection. */
async function echCheck(url: string): Promise<Check> {
  const host = new URL(url).hostname;
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=HTTPS`, { headers: { accept: 'application/dns-json' } }).catch(() => null);
  const data = (await res?.json().catch(() => null)) as { Answer?: { data: string }[] } | null;
  const ech = (data?.Answer ?? []).some((a) => /\bech=/.test(a.data));
  return ech
    ? {
        id: 'server.ech',
        level: 'fail',
        title: 'DNS does not advertise Encrypted ClientHello',
        detail: `${host} has ech= in its HTTPS record`,
        fix: "Turn ECH off for this domain (Cloudflare: PATCH zones/<id>/settings/ech {\"value\":\"off\"}; it's API-only on the free plan). TLS-inspecting review proxies reset ECH handshakes: three ChatGPT rejections traced back to this, with nothing in the server's logs.",
        stores: ['chatgpt'],
      }
    : { id: 'server.ech', level: 'pass', title: 'DNS does not advertise Encrypted ClientHello' };
}
