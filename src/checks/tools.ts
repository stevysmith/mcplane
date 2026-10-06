import type { Check, Tool } from '../types.js';

const HINTS = ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const;

/** Phrases that read as instructions to the model rather than a description of the tool. */
const INSTRUCTION = [
  /\byou (must|should|always|never)\b/i,
  /\balways (call|use|run)\b/i,
  /\bnever (call|use|tell|mention)\b/i,
  /\bignore (previous|prior|other|all)\b/i,
  /\b(before|after) (calling|using) (this|any|another) tool\b/i,
  /\buse this tool (whenever|for every|for all)\b/i,
  /\bdo not (tell|inform|mention)\b/i,
  /\bonly (call|use) (this|it|with|when)\b/i,
  /\b(call|use) (this|it) only\b/i,
];

/** Plan and pricing copy. OpenAI prohibits in-app upsells, "including freemium upsells". */
// Plan and tier language only: product prices ("live pricing", "premium cars") are not upsells.
const UPSELL = /\b(upgrade (to|your|now)|pro plan|premium (plan|tier|account|subscription|version)|paid (plan|tier|account)|free trial|subscribe (to|now)|unlock (more|premium|pro|unlimited|all))\b/i;

/** Inputs that suggest a write authorised only by a secret passed through the chat. */
const BEARER_INPUT = /^(token|edit_token|update_token|secret|access_key|api_key|password)$/i;

/** OpenAI's destructive effects ("deletion, overwriting, cancellation, access revocation") in the words a tool uses about itself. */
const DESTRUCTIVE = /\b(overwrit\w*|replac\w*|revo[kc]\w*|delet\w*|cancel\w*|archiv\w*|expir\w*|passwords?|gat(?:e|es|ed|ing))\b/gi;
const NEGATED = /\b(never|not|no|without|nothing|refuses?|cannot|can['’]t|doesn['’]t|don['’]t|won['’]t)\b(\s+\w+){0,2}\s*$/i;

/**
 * Destructive options in an input schema. No "-ed" forms: they describe a state (include_deleted, "the deleted
 * page's id"), not what the option does. Passcodes and gates stay out: a passcode on a page the call creates
 * revokes nothing.
 */
const DESTRUCTIVE_OPTION = /\b(burn[\s_-]+after[\s_-]+read\w*|self[\s_-]?destruct(?:s|ing)?|delet(?:e|es|ing|ion)|destroy(?:s|ing)?|overwrit(?:e|es|ing)|replac(?:e|es|ing|ement)|revok(?:e|es|ing)|revocation|purg(?:e|es|ing)|wip(?:e|es|ing)|eras(?:e|es|ing|ure)|expir(?:e|es|ing|y|ation))\b/gi;

/** Tools that make something new: a creating verb anywhere in the name (api_create_key), or first when it's also a noun (update_post isn't one). */
const CREATES = /\b(create|add|new|publish|upload|mint|generate|insert)\b|^(post|share|invite|issue|schedule|make)\b/i;

/** Crypto: wallets, chains, signing schemes and stablecoins. */
const CRYPTO = /\b(crypto(?:currenc(?:y|ies))?|wallets?|on[\s-]?chain|blockchains?|web3|eip[\s-]?(?:191|712)|personal[\s_-]?sign|eth[\s_-]sign|sign[\s_-]?typed[\s_-]?data|usdc|usdt|stablecoins?|bitcoin|ethereum|solana|x402|nfts?|seed phrases?)\b/gi;

/**
 * Moving money, as a verb with what it moves. Like UPSELL, phrases only: prices, pricing pages and billing
 * links aren't money movement, and neither is a purchase history or a hotel's check-out date.
 */
const MONEY = /\b(transfer(?:s|ring)? (?:the |your )?(?:funds|money|payments?)|send(?:s|ing)? (?:a |the |your )?(?:money|funds|payments?)|(?:make|makes|making|complete|completes|process|processes|processing|submit|submits|execute|executes) (?:a |the )?(?:payments?|purchases?)|pay(?:s|ing)? (?:an? |the |your )?(?:invoices?|bills?)|charg(?:e|es|ing) (?:a |the |their |your )?(?:cards?|customers?)|refund(?:s|ing)? (?:an? |the |their |your )?(?:customers?|orders?|payments?|charges?)|issu(?:e|es|ing) (?:a )?refunds?|(?:withdraw|deposit)(?:s|ing)? (?:funds|money)|(?:purchas(?:e|es|ing)|buy(?:s|ing)?) (?:an?|the|this|it)|checkouts?(?![\s_-]*(?:date|time|day)))\b/gi;

/** The words a pattern finds in text, skipping negated ones ("never overwrites"). */
function mentions(text: string, re: RegExp): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(re)) {
    if (NEGATED.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    found.add(m[0].toLowerCase().replace(/\s+/g, ' '));
  }
  return [...found];
}

/** The destructive words in a tool's name, title and description. */
const destructiveWords = (text: string) => mentions(text, DESTRUCTIVE);

/** A name as words: set_password and setPassword both read "set password". */
const words = (name: string) => name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

/** A tool's input properties and the ones a level down (an object's properties, an array's items), by path. */
function inputProps(t: Tool): [string, Record<string, any>][] {
  return Object.entries(t.inputSchema?.properties ?? {}).flatMap(([k, v]) => {
    const p = (v ?? {}) as Record<string, any>;
    const kids = (p.properties ?? p.items?.properties ?? {}) as Record<string, unknown>;
    return [[k, p] as [string, Record<string, any>], ...Object.entries(kids).map(([c, cv]) => [`${k}.${c}`, (cv ?? {}) as Record<string, any>] as [string, Record<string, any>])];
  });
}

/**
 * The destructive words in what a property says about itself: its name, string enum values ("overwrite") and
 * description. "Replace" counts in names and values only: descriptions use it loosely ("until a refresh replaces them").
 */
function optionWords(path: string, p: Record<string, any>): string[] {
  const values = Array.isArray(p.enum) ? p.enum.filter((e: unknown) => typeof e === 'string').join(' ') : '';
  const named = mentions(`${words(path.split('.').pop()!)} ${values}`, DESTRUCTIVE_OPTION);
  const described = mentions(typeof p.description === 'string' ? p.description : '', DESTRUCTIVE_OPTION).filter((w) => !w.startsWith('replac'));
  return [...new Set([...named, ...described])];
}

export function toolChecks(tools: Tool[]): Check[] {
  if (!tools.length) return [];
  const checks: Check[] = [];

  const noTitle = tools.filter((t) => !t.title && !t.annotations?.title);
  checks.push(
    noTitle.length
      ? { id: 'tools.title', level: 'warn', title: 'Every tool has a human-readable title', detail: noTitle.map((t) => t.name).join(', '), fix: 'Add "title" (or annotations.title) to each tool. Clients show the raw name without one, and Anthropic’s reviewers ask for them on new submissions.', stores: ['claude-connectors', 'claude-plugins'] }
      : { id: 'tools.title', level: 'pass', title: 'Every tool has a human-readable title' },
  );

  const missing = tools.flatMap((t) => HINTS.filter((h) => typeof t.annotations?.[h] !== 'boolean').map((h) => `${t.name}.${h}`));
  checks.push(
    missing.length
      ? {
          id: 'tools.hints',
          level: 'fail',
          title: 'Safety annotations are explicit on every tool',
          detail: missing.join(', '),
          fix: 'Set readOnlyHint, destructiveHint and openWorldHint to true or false on every tool. ChatGPT requires explicit values and its automated review checks them against what each tool does (justifications are no longer required; appeal if it flags one you believe is right). Claude checks them against your read/write answer.',
          stores: ['chatgpt', 'claude-connectors'],
        }
      : { id: 'tools.hints', level: 'pass', title: 'Safety annotations are explicit on every tool' },
  );

  const contradictory = tools.filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true);
  if (contradictory.length) {
    checks.push({ id: 'tools.hints-consistent', level: 'fail', title: 'Annotations are consistent', detail: `read-only yet destructive: ${contradictory.map((t) => t.name).join(', ')}`, fix: 'A read-only tool cannot be destructive.' });
  }

  const noOutput = tools.filter((t) => !t.outputSchema);
  checks.push(
    noOutput.length
      ? { id: 'tools.output-schema', level: 'warn', title: 'Tools declare an outputSchema', detail: noOutput.map((t) => t.name).join(', '), fix: 'Declare outputSchema and return structuredContent that matches it. ChatGPT recommends it on every tool during review.', stores: ['chatgpt'] }
      : { id: 'tools.output-schema', level: 'pass', title: 'Tools declare an outputSchema' },
  );

  const instructing = tools.flatMap((t) => {
    const text = `${t.description ?? ''}`;
    const hits = INSTRUCTION.filter((re) => re.test(text)).map((re) => text.match(re)![0]);
    // Naming a sibling tool ("call get_session first") is common in approved listings, so only explicit instructions count.
    return hits.length ? [`${t.name}: ${hits.map((h) => `"${h}"`).join(', ')}`] : [];
  });
  checks.push(
    instructing.length
      ? {
          id: 'tools.no-instructions',
          level: 'warn',
          title: 'Descriptions describe the tool, not the model’s behaviour',
          detail: instructing.join('; '),
          fix: "Anthropic's submission asks you to confirm tool descriptions contain no instructions about model behaviour or other tools. Rephrase as facts about what the tool does, or explain the line in the form's Additional notes.",
          stores: ['claude-connectors', 'claude-plugins'],
        }
      : { id: 'tools.no-instructions', level: 'pass', title: 'Descriptions describe the tool, not the model’s behaviour' },
  );

  const bearer = tools.filter((t) => t.annotations?.readOnlyHint !== true && Object.keys(t.inputSchema?.properties ?? {}).some((k) => BEARER_INPUT.test(k)));
  checks.push(
    bearer.length
      ? {
          id: 'tools.bearer-writes',
          level: 'fail',
          title: 'Writes are bound to an owner, not a token in the chat',
          detail: bearer.map((t) => t.name).join(', '),
          fix: 'Anthropic rejected a write tool authorised only by a token passed through the conversation ("anyone who obtains or guesses a token can rewrite"). Put writes behind OAuth, or move them to your site and email the owner a private link.',
          stores: ['claude-connectors'],
        }
      : { id: 'tools.bearer-writes', level: 'pass', title: 'Writes are bound to an owner, not a token in the chat' },
  );

  // OpenAI: openWorldHint is true for public or open-ended entities, read-only web search and arbitrary destinations
  // included; a tool confined to a bounded private account, workspace or catalog may be false. Connectivity alone doesn't decide it.
  const openWorld = tools.filter(
    (t) =>
      t.annotations?.openWorldHint === false &&
      /\b(send|sends|sent|e-?mail(s|ed)?|post|posts|publish|publishes|public|tweet|message|notify|notifies|web search|search the web|internet|any url|fetch(es)? (a |the |any )?url|scrape|scrapes|crawl|crawls)\b/i.test(`${t.description ?? ''} ${Object.keys(t.inputSchema?.properties ?? {}).join(' ')}`),
  );
  checks.push(
    openWorld.length
      ? {
          id: 'tools.open-world',
          level: 'warn',
          title: 'openWorldHint matches what the tool does',
          detail: `${openWorld.map((t) => t.name).join(', ')}: openWorldHint is false, but the tool seems to reach public or open-ended destinations (sending, posting, publishing or searching the web)`,
          fix: 'OpenAI: use true "for public or open-ended entities, including read-only web search and arbitrary destinations". A tool "confined to a bounded private account, workspace, or catalog may use false, even when externally hosted", and "connectivity alone does not determine this value". If it only reaches the user’s own account, false is right.',
          stores: ['chatgpt'],
        }
      : { id: 'tools.open-world', level: 'pass', title: 'openWorldHint matches what the tool does' },
  );

  // OpenAI: for writes, destructiveHint is true for destructive or irreversible effects, "irreversible sends or transactions" included.
  const sends = tools.filter((t) => t.annotations?.destructiveHint === false && t.annotations?.readOnlyHint !== true && /\b(sends?|sent|e-?mail(s|ed)?|sms|texts?|messag(es?|ed)|notif(y|ies|ied)|transfers?|pays?|payments?)\b/i.test(t.description ?? ''));
  if (sends.length) {
    checks.push({
      id: 'tools.destructive-send',
      level: 'warn',
      title: 'destructiveHint covers messages that can’t be unsent',
      detail: `${sends.map((t) => t.name).join(', ')}: destructiveHint is false, but the tool seems to send something`,
      fix: 'OpenAI: for writes, use true "for potentially destructive or irreversible effects, such as deletion, overwriting, cancellation, access revocation, or irreversible sends or transactions", and false "only for additive writes without destructive or irreversible effects". A message can’t be unsent, so set it to true, and ask for confirmation before it goes.',
      stores: ['chatgpt'],
    });
  }

  // The same definition covers overwriting, revoking access and deleting; an undo doesn't change that.
  // Conservative: explicit write tools whose own words say so, negated mentions ("never overwrites") excluded.
  const destroys = tools.flatMap((t) => {
    if (t.annotations?.readOnlyHint !== false || t.annotations?.destructiveHint !== false) return [];
    const found = destructiveWords(`${words(t.name)} ${t.title ?? ''} ${t.description ?? ''}`);
    return found.length ? [`${t.name} (${found.join(', ')})`] : [];
  });
  if (destroys.length) {
    checks.push({
      id: 'tools.destructive-overwrite',
      level: 'warn',
      title: 'destructiveHint covers overwriting, revoking and deleting',
      detail: `${destroys.join('; ')}: destructiveHint is false, but the tool seems to overwrite, revoke access or delete`,
      fix: 'OpenAI: for writes, use true "for potentially destructive or irreversible effects, such as deletion, overwriting, cancellation, access revocation, or irreversible sends or transactions". "Being able to undo an action does not, by itself, justify setting destructiveHint to false." If the tool only adds, keep false, and appeal if review flags it.',
      stores: ['chatgpt'],
    });
  }

  // ChatGPT's scan reads the input schema too: it flagged Stacktree's publish_html, marked non-destructive, for
  // offering burn_after_read, and a rescan cleared it once the option was gone from the advertised schema (Oct 2026).
  // Conservative: property names, descriptions and enum values, one level deep. Expiry is the trade-off: it only
  // counts on tools that change something that exists. On a tool that creates (a publish's lifetime, a share
  // link's expires_in) it bounds what the call itself adds, and publish_html kept expires_in_hours through
  // that rescan. An expiry on an update tool still counts: it can take a live page down.
  const options = tools.flatMap((t) => {
    if (t.annotations?.readOnlyHint !== false || t.annotations?.destructiveHint !== false) return [];
    const creates = CREATES.test(words(t.name));
    return inputProps(t).flatMap(([path, p]) => {
      const found = optionWords(path, p).filter((w) => !(creates && w.startsWith('expir')));
      return found.length ? [`${t.name}.${path} (${found.join(', ')})`] : [];
    });
  });
  if (options.length) {
    checks.push({
      id: 'tools.destructive-option',
      level: 'warn',
      title: 'destructiveHint covers the options a tool’s schema offers',
      detail: `${options.join('; ')}: destructiveHint is false, but the schema offers an option that deletes, overwrites, revokes or expires`,
      fix: 'Set destructiveHint to true, or stop advertising the option in the schema you serve ChatGPT; your server can keep honouring it for older clients that still send it. ChatGPT’s scan flagged a publish tool marked non-destructive whose schema offered burn_after_read, and removing the option from the advertised schema cleared the flag on rescan.',
      stores: ['chatgpt'],
    });
  }

  // Before submitting, ChatGPT has the developer attest that the app involves no money or crypto.
  // Moving money is a write, so read-only tools are judged by what they're about (name, title, property names) and a
  // passing mention in their description doesn't count ("inflation, GDP, crypto and more").
  const money = tools.flatMap((t) => {
    const about = `${words(t.name)} ${t.title ?? ''} ${t.annotations?.title ?? ''} ${inputProps(t).map(([path]) => words(path.split('.').pop()!)).join(' ')}`;
    const readOnly = t.annotations?.readOnlyHint === true;
    const text = readOnly ? about : `${about} ${t.description ?? ''}`;
    const found = [...mentions(text, CRYPTO), ...(readOnly ? [] : mentions(text, MONEY))];
    return found.length ? [`${t.name} (${found.join(', ')})`] : [];
  });
  if (money.length) {
    checks.push({
      id: 'tools.money-crypto',
      level: 'warn',
      title: 'Tools don’t move money or handle crypto',
      detail: `${money.join('; ')}: the tool seems to move money or handle crypto`,
      fix: 'ChatGPT’s final submit step has you tick an attestation that the app involves no money or crypto. Remove the tool, or hide it from ChatGPT connections only: leave it out of their tools/list and refuse calls to it. Stacktree serves a per-client tool profile, and a client counts as ChatGPT when every OAuth redirect URI it registered is on chatgpt.com or openai.com, or its client name is "ChatGPT". "Every", not "any": some clients register a claude.ai callback beside a chatgpt.com one.',
      stores: ['chatgpt'],
    });
  }

  const long = tools.filter((t) => t.name.length > 64);
  if (long.length) checks.push({ id: 'tools.name-length', level: 'fail', title: 'Tool names are 64 characters or fewer', detail: long.map((t) => t.name).join(', '), fix: 'Anthropic’s review criteria cap tool names at 64 characters.', stores: ['claude-connectors', 'claude-plugins'] });

  // A tool that takes an HTTP method and a path is one tool doing both reads and writes.
  const catchAll = tools.filter((t) => {
    const keys = Object.keys(t.inputSchema?.properties ?? {}).map((k) => k.toLowerCase());
    return keys.some((k) => k === 'method' || k === 'http_method' || k === 'verb') && keys.some((k) => /^(path|endpoint|url|route)$/.test(k));
  });
  if (catchAll.length) {
    checks.push({ id: 'tools.catch-all', level: 'warn', title: 'No catch-all request tool', detail: catchAll.map((t) => t.name).join(', '), fix: 'Anthropic rejects a single tool that makes any API call (e.g. api_request with a method parameter). Split it into read tools and write tools with honest hints.', stores: ['claude-connectors'] });
  }

  // Inputs that ask for data OpenAI treats as sensitive.
  const sensitive = tools.flatMap((t) =>
    Object.keys(t.inputSchema?.properties ?? {})
      .filter((k) => /(ssn|social_security|passport|national_id|tax_id|credit_card|card_number|cvv|iban|password|mfa|otp|2fa|diagnos|medical|health_record|biometric|fingerprint)/i.test(k))
      .map((k) => `${t.name}.${k}`),
  );
  if (sensitive.length) {
    checks.push({ id: 'tools.sensitive-inputs', level: 'fail', title: 'Tools don’t ask for sensitive data', detail: sensitive.join(', '), fix: 'OpenAI flags inputs that request PHI, card data, SSNs, credentials, MFA codes, government IDs or biometrics unless strictly necessary. Remove them or justify them in the submission.', stores: ['chatgpt'] });
  }

  const upsell = tools.filter((t) => UPSELL.test(`${t.title ?? ''} ${t.annotations?.title ?? ''} ${t.description ?? ''}`));
  checks.push(
    upsell.length
      ? { id: 'tools.no-upsell', level: 'fail', title: 'No upgrade or pricing copy in tools', detail: upsell.map((t) => t.name).join(', '), fix: 'OpenAI prohibits in-app commerce for digital subscriptions, including freemium upsells. Keep plans and pricing on your site; tool text and errors should not steer users to upgrade.', stores: ['chatgpt'] }
      : { id: 'tools.no-upsell', level: 'pass', title: 'No upgrade or pricing copy in tools' },
  );

  // ChatGPT extensions (DevDay 2026): entrypoints declared in _meta["openai/ui"]. Reported so they show up in reviews and drift.
  const ext = tools.flatMap((t) =>
    (((t._meta?.['openai/ui'] as { entrypoints?: { type: string; extensions?: string[] }[] } | undefined)?.entrypoints) ?? []).map((e) => `${t.name}: ${e.type}${e.extensions?.length ? ` (${e.extensions.join(', ')})` : ''}`),
  );
  if (ext.length) checks.push({ id: 'tools.extensions', level: 'pass', title: 'ChatGPT extensions declared', detail: ext.join('; '), stores: ['chatgpt'] });

  return checks;
}
