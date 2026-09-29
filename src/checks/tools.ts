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
const UPSELL = /\b(upgrade|pro plan|premium|paid plan|pricing|subscribe|subscription|free trial|unlock)\b/i;

/** Inputs that suggest a write authorised only by a secret passed through the chat. */
const BEARER_INPUT = /^(token|edit_token|update_token|secret|access_key|api_key|password)$/i;

export function toolChecks(tools: Tool[]): Check[] {
  if (!tools.length) return [];
  const checks: Check[] = [];
  const names = new Set(tools.map((t) => t.name));

  const noTitle = tools.filter((t) => !t.title && !t.annotations?.title);
  checks.push(
    noTitle.length
      ? { id: 'tools.title', level: 'fail', title: 'Every tool has a human-readable title', detail: noTitle.map((t) => t.name).join(', '), fix: 'Add "title" (or annotations.title) to each tool. Anthropic rejects connectors without them.', stores: ['claude-connectors', 'claude-plugins'] }
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
          fix: 'Set readOnlyHint, destructiveHint and openWorldHint to true or false on every tool. ChatGPT asks you to justify each explicit value and flags missing ones; Claude checks them against your read/write answer.',
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
    const others = [...names].filter((n) => n !== t.name && text.includes(n));
    return hits.length || others.length ? [`${t.name}: ${[...hits.map((h) => `"${h}"`), ...others.map((n) => `mentions ${n}`)].join(', ')}`] : [];
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

  // OpenAI's reviewers read openWorldHint as "can change public or third-party state": sending email, posting, publishing.
  const openWorld = tools.filter(
    (t) =>
      t.annotations?.openWorldHint === false &&
      /\b(send|sends|email|emails|post|posts|publish|publishes|public|tweet|message|notify|notifies)\b/i.test(`${t.description ?? ''} ${Object.keys(t.inputSchema?.properties ?? {}).join(' ')}`),
  );
  checks.push(
    openWorld.length
      ? {
          id: 'tools.open-world',
          level: 'warn',
          title: 'openWorldHint matches what the tool does',
          detail: `${openWorld.map((t) => t.name).join(', ')}: openWorldHint is false, but the tool seems to send, post or publish`,
          fix: 'OpenAI defines openWorldHint as true when a tool "can change publicly visible internet state or external third-party systems, such as sending emails or messages, posting/publishing content". If yours does, set it to true.',
          stores: ['chatgpt'],
        }
      : { id: 'tools.open-world', level: 'pass', title: 'openWorldHint matches what the tool does' },
  );

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

  return checks;
}
