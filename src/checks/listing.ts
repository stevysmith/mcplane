import type { Check, Manifest, StoreId, Tool } from '../types.js';

const get = (url: string) => fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'mcplane' } }).catch(() => null);

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: Uint8Array): { w: number; h: number } | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  const v = new DataView(buf.buffer, buf.byteOffset);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

const has = (stores: StoreId[], ...s: StoreId[]) => s.some((x) => stores.includes(x));

export async function listingChecks(m: Manifest, tools: Tool[], stores: StoreId[]): Promise<Check[]> {
  const checks: Check[] = [];
  const origin = new URL(m.server.url).origin;

  // Icon
  if (!m.icon) {
    checks.push({ id: 'listing.icon', level: 'warn', title: 'An icon URL is set', fix: 'Set "icon" to a direct PNG URL, at least 512×512. ChatGPT needs one uploaded; Claude asks for a direct .png/.svg URL when the favicon fails.' });
  } else {
    const res = await get(m.icon);
    const type = res?.headers.get('content-type') ?? '';
    const buf = res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    const size = buf ? pngSize(buf) : null;
    if (!res?.ok) {
      checks.push({ id: 'listing.icon', level: 'fail', title: 'The icon URL loads', detail: `HTTP ${res?.status ?? 'error'}`, fix: 'Point "icon" at a URL that returns the image directly.' });
    } else if (!/\.(png|svg|jpe?g|gif|ico|webp)(\?|$)/i.test(m.icon)) {
      checks.push({ id: 'listing.icon', level: 'warn', title: 'The icon URL ends in an image extension', detail: m.icon, fix: 'Anthropic asks for an icon URL ending in .png, .svg, .jpg, .gif, .ico or .webp.', stores: ['claude-connectors'] });
    } else if (type.includes('png') && size && (size.w < 512 || size.w !== size.h)) {
      checks.push({ id: 'listing.icon', level: 'warn', title: 'The icon is square and at least 512 px', detail: `${size.w}×${size.h}`, fix: 'Use a square PNG of 512×512 or more; ChatGPT’s directory icon must be at least 256, and a 512 master covers every store.' });
    } else {
      checks.push({ id: 'listing.icon', level: 'pass', title: 'The icon loads', detail: `${type}${size ? `, ${size.w}×${size.h}` : ''}, ${buf ? Math.round(buf.length / 1024) : '?'} KB` });
      if (buf && buf.length > 10 * 1024 && has(stores, 'chatgpt')) {
        checks.push({ id: 'listing.icon-small', level: 'warn', title: 'A small icon is available for ChatGPT’s dialogs', detail: `${Math.round(buf.length / 1024)} KB`, fix: 'ChatGPT’s icon upload in developer mode caps at 10 KB. Export an 8-bit PNG (pngquant or `magick in.png PNG8:out.png`).', stores: ['chatgpt'] });
      }
    }
  }

  // Favicon, the fallback Claude's directory reads.
  const fav = await get(`${origin}/favicon.ico`);
  checks.push(
    fav?.ok
      ? { id: 'listing.favicon', level: 'pass', title: '/favicon.ico resolves on the server’s domain' }
      : { id: 'listing.favicon', level: 'warn', title: '/favicon.ico resolves on the server’s domain', detail: `HTTP ${fav?.status ?? 'error'}`, fix: `Serve ${origin}/favicon.ico. Anthropic's reviewers reported "the fallback favicon is not resolving" when this 404'd.`, stores: ['claude-connectors'] },
  );

  // Privacy policy
  const privacyUrl = m.links?.privacy;
  if (!privacyUrl) {
    checks.push({ id: 'listing.privacy', level: 'fail', title: 'A privacy policy is linked', fix: 'Every store requires one. Add links.privacy.' });
  } else {
    const res = await get(privacyUrl);
    const text = res?.ok ? (await res.text()).replace(/<[^>]+>/g, ' ').toLowerCase() : '';
    if (!res?.ok) {
      checks.push({ id: 'listing.privacy', level: 'fail', title: 'The privacy policy loads', detail: `HTTP ${res?.status ?? 'error'}` });
    } else {
      const missing = [
        !/(retain|retention|how long|keep (it|them|your)|deleted? after)/.test(text) && 'how long data is kept',
        !/(delete|remove|unsubscribe|opt out|your (rights|choices))/.test(text) && 'what users can do about their data',
        !/(collect|store|we keep|information we)/.test(text) && 'what is collected',
      ].filter(Boolean) as string[];
      checks.push(
        missing.length
          ? { id: 'listing.privacy', level: 'warn', title: 'The privacy policy covers what reviewers look for', detail: `doesn’t seem to cover: ${missing.join(', ')}`, fix: 'OpenAI requires the policy to describe the data collected, its use, sharing, retention timelines and user controls.', stores: ['chatgpt'] }
          : { id: 'listing.privacy', level: 'pass', title: 'The privacy policy covers collection, retention and user controls' },
      );
      // Tools that take free-form content need that disclosed.
      const freeForm = tools.filter((t) => Object.keys(t.inputSchema?.properties ?? {}).some((k) => /^(html|content|body|document|message|text|file|markdown)$/i.test(k)));
      if (freeForm.length && !/(content|document|html|message|file)s? (you|that you|we receive|submitted|uploaded|published)/.test(text)) {
        checks.push({
          id: 'listing.privacy-content',
          level: 'warn',
          title: 'Free-form content is covered by the privacy policy',
          detail: `${freeForm.map((t) => t.name).join(', ')} accept free-form content`,
          fix: 'Say what happens to content users send through these tools: what is stored, for how long, and any automatic screening for sensitive data. A "sensitive data" rejection on ChatGPT was answered by exactly this section.',
          stores: ['chatgpt'],
        });
      }
    }
  }

  // Support must be a URL for ChatGPT.
  const support = m.links?.support;
  if (has(stores, 'chatgpt')) {
    checks.push(
      support && /^https?:\/\//.test(support)
        ? { id: 'listing.support', level: 'pass', title: 'Support is a web page', stores: ['chatgpt'] }
        : { id: 'listing.support', level: 'fail', title: 'Support is a web page', detail: support ?? 'missing', fix: 'ChatGPT’s form wants a customer support URL, not an email address. A /support page with your email on it is enough.', stores: ['chatgpt'] },
    );
  }

  // Lengths the forms enforce (some silently).
  const len = (v: string | undefined, max: number, id: string, label: string, s: StoreId[]) => {
    if (v && v.length > max) checks.push({ id, level: 'fail', title: `${label} fits (${max} characters)`, detail: `${v.length} characters`, stores: s });
    else if (v) checks.push({ id, level: 'pass', title: `${label} fits (${max} characters)`, stores: s });
  };
  if (has(stores, 'chatgpt')) len(m.subtitle, 30, 'listing.subtitle', 'Subtitle', ['chatgpt']);
  if (has(stores, 'claude-connectors', 'claude-plugins')) len(m.oneLiner, 200, 'listing.one-liner', 'One-liner', ['claude-connectors', 'claude-plugins']);
  len(m.description, 2000, 'listing.description', 'Description', []);

  // ChatGPT domain verification
  if (has(stores, 'chatgpt')) {
    const ch = await get(`${origin}/.well-known/openai-apps-challenge`);
    const body = ch?.ok ? (await ch.text()).trim() : '';
    checks.push(
      body && body.length < 200 && !/<html/i.test(body)
        ? { id: 'listing.openai-challenge', level: 'pass', title: 'ChatGPT domain challenge is served', stores: ['chatgpt'] }
        : { id: 'listing.openai-challenge', level: 'warn', title: 'ChatGPT domain challenge is served', detail: `HTTP ${ch?.status ?? 'error'}`, fix: `The ChatGPT form gives you a token to serve as plain text at ${origin}/.well-known/openai-apps-challenge. Add it before the MCP step, or domain verification blocks submission.`, stores: ['chatgpt'] },
    );
  }

  return checks;
}

/** Rules for plugin repositories (Claude plugins, Cursor, Grok). */
export async function repoChecks(m: Manifest, stores: StoreId[]): Promise<Check[]> {
  if (!m.repository || !has(stores, 'claude-plugins', 'cursor', 'grok')) return [];
  const gh = m.repository.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!gh) return [{ id: 'repo.github', level: 'warn', title: 'The plugin repository is on GitHub', detail: m.repository, fix: 'Claude, Cursor and Grok all read plugins from a public GitHub repository.' }];
  const [, owner, repo] = gh;
  const api = (p: string) => fetch(`https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, '')}${p}`, { headers: { 'user-agent': 'mcplane', accept: 'application/vnd.github+json' } }).catch(() => null);
  const checks: Check[] = [];
  const meta = await api('');
  if (!meta?.ok) {
    return [{ id: 'repo.public', level: 'fail', title: 'The plugin repository is public', detail: `HTTP ${meta?.status ?? 'error'}`, fix: 'Stores pin a commit of a public repo. A private monorepo can’t host the plugin: move it to its own public repository.' }];
  }
  const info = (await meta.json()) as { owner?: { type?: string } };
  checks.push({ id: 'repo.public', level: 'pass', title: 'The plugin repository is public' });
  const exists = async (p: string) => (await api(`/contents/${p}`))?.ok ?? false;
  if (has(stores, 'claude-plugins')) {
    const [manifest, rootSkill, skillsDir] = await Promise.all([exists('.claude-plugin/plugin.json'), exists('SKILL.md'), exists('skills')]);
    checks.push(
      manifest
        ? { id: 'repo.claude-manifest', level: 'pass', title: '.claude-plugin/plugin.json exists', stores: ['claude-plugins'] }
        : { id: 'repo.claude-manifest', level: 'fail', title: '.claude-plugin/plugin.json exists', fix: 'Add a plugin manifest and run `claude plugin validate`.', stores: ['claude-plugins'] },
    );
    if (rootSkill && skillsDir) {
      checks.push({ id: 'repo.root-skill', level: 'warn', title: 'No root SKILL.md shadowing the plugin’s skills', fix: 'A SKILL.md at the repo root makes it load as a single-skill plugin and hides everything in skills/. Move it under skills/.', stores: ['claude-plugins'] });
    }
  }
  if (has(stores, 'grok') && info.owner?.type === 'User') {
    checks.push({ id: 'repo.grok-org', level: 'warn', title: 'Grok plugin comes from an organisation', detail: `${owner} is a personal account`, fix: 'xAI’s guide says plugins sourced from personal accounts "will be questioned". Transfer the repo to an organisation named after the product.', stores: ['grok'] });
  }
  return checks;
}
