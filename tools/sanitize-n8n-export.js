#!/usr/bin/env node
/**
 * Strip instance-specific identifiers out of an n8n workflow export so it can be
 * published.
 *
 * An n8n export is not safe to commit as-is. It carries credential IDs, webhook
 * IDs, Slack channel IDs, and Google Drive / Sheets / Docs file IDs. None of those
 * are passwords, but together they map your instance and, in the Drive case, point
 * at real documents. Git history is permanent, so this has to run before the first
 * commit, not after someone notices.
 *
 * Usage:
 *   node tools/sanitize-n8n-export.js <input.json> [output.json]
 *
 * Defaults output to <input>.sanitized.json next to the input.
 */

const fs = require('fs');
const path = require('path');

// Google file/folder IDs: 25+ chars of base64url. Long enough not to collide with
// ordinary words, which a shorter bound would.
const GOOGLE_ID = /\b[A-Za-z0-9_-]{25,}\b/g;
const GMAIL_LABEL = /\bLabel_[0-9]{6,}\b/g;
const SLACK_CHANNEL = /\bC[A-Z0-9]{8,}\b/g;
const SLACK_TEAM = /\bT[A-Z0-9]{8,}\b/g;
// Non-capturing on purpose: RULES below relies on exactly one capture group per rule.
const BEARERISH = /\b(?:fc-|sk-|xox[baprs]-|ghp_|gho_)[A-Za-z0-9_-]{10,}/g;
// Real addresses leak both the person and the domain. `@` is outside the ID character
// class, so nothing else in this file would ever catch one.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const PLACEHOLDER = {
  credentialId: 'REPLACE_WITH_YOUR_CREDENTIAL_ID',
  webhookId: 'REPLACE_WITH_YOUR_WEBHOOK_ID',
  googleId: 'REPLACE_WITH_YOUR_GOOGLE_FILE_ID',
  gmailLabel: 'REPLACE_WITH_YOUR_GMAIL_LABEL_ID',
  slackChannel: 'REPLACE_WITH_YOUR_SLACK_CHANNEL_ID',
  slackTeam: 'REPLACE_WITH_YOUR_SLACK_TEAM_ID',
  token: 'REPLACE_WITH_YOUR_TOKEN',
  email: 'REPLACE_WITH_YOUR_EMAIL',
  workflowId: 'REPLACE_WITH_YOUR_WORKFLOW_ID',
  dataTableId: 'REPLACE_WITH_YOUR_DATA_TABLE_ID',
};

// n8n's own resource ids (workflows, data tables, credentials) are 16 chars — short
// enough that a generic long-token regex misses them. They have to be matched by the
// key they sit under, not by their shape.
const N8N_RESOURCE_KEYS = new Set(['workflowId', 'dataTableId']);
const STRUCTURAL_KEYS = new Set(['id', 'type']);

// Instance state that is not part of the workflow definition and must never ship.
// The draft/publish keys matter more than they look: the REST API (unlike the editor's
// Download button) returns an `activeVersion` block holding a SECOND full copy of every
// node plus a publish history stamped with a real n8n `userId`. On a 57-node workflow
// that is half the export by weight, and it re-introduces identifiers the walk below
// has already scrubbed out of the draft copy. Deleting the block is correct rather than
// merely cheaper: n8n only needs name/nodes/connections/settings to import.
const INSTANCE_STATE_KEYS = [
  'id',
  'versionId',
  'meta',
  'pinData',
  'staticData',
  'shared',
  'triggerCount',
  'activeVersion',
  'activeVersionId',
  'sourceWorkflowId',
  'versionCounter',
  'createdAt',
  'updatedAt',
];
const isIdShaped = (s) =>
  /^[A-Za-z0-9_-]{16,}$/.test(s) || /^C[A-Z0-9]{8,}$/.test(s);

const findings = [];
const note = (kind, value) => {
  findings.push(`${kind}: ${String(value).slice(0, 12)}…`);
};

// Things too ambiguous to auto-replace without mangling legitimate text, but which
// a human should look at before publishing. Channel *names* are the common case:
// "urgent-email-errors" is indistinguishable from prose to a regex, but it still
// leaks internal naming.
const review = [];

// One combined pass, not a chain of .replace() calls. Chaining is wrong here: the
// placeholders are themselves long runs of [A-Za-z_], so a later rule happily matches
// a placeholder an earlier rule just inserted and overwrites it — silently relabelling
// every Slack channel as a Google file id. A single pass consumes each position once.
//
// Google ids are listed before Slack ids deliberately: a real Slack channel (~11 chars)
// can never satisfy the 25-char minimum, but a long all-caps Google id could otherwise
// be swallowed by the Slack rule.
// Email is listed before the id rules so a long local part or domain can't be eaten
// piecemeal by GOOGLE_ID. Gmail label ids likewise precede GOOGLE_ID, which would
// otherwise swallow them and mislabel them as Drive files.
const RULES = [
  { kind: 'token', re: BEARERISH, placeholder: PLACEHOLDER.token },
  { kind: 'email', re: EMAIL, placeholder: PLACEHOLDER.email },
  { kind: 'gmail label', re: GMAIL_LABEL, placeholder: PLACEHOLDER.gmailLabel },
  { kind: 'google id', re: GOOGLE_ID, placeholder: PLACEHOLDER.googleId },
  { kind: 'slack channel', re: SLACK_CHANNEL, placeholder: PLACEHOLDER.slackChannel },
  { kind: 'slack team', re: SLACK_TEAM, placeholder: PLACEHOLDER.slackTeam },
];

const COMBINED = new RegExp(RULES.map((r) => `(${r.re.source})`).join('|'), 'g');

// A long run of lowercase-and-underscores is a snake_case identifier, not an opaque id:
// Supabase's `match_documents_gadgets_more` clears GOOGLE_ID's 25-char bar purely by
// being descriptive. Real Drive/Slack ids are base64url and effectively always carry a
// digit or a capital. Redacting these names would strip information the export exists to
// document, so they pass through — but they still get surfaced for a human to confirm.
const isDescriptiveName = (s) => /^[a-z][a-z_]*$/.test(s);

function scrubString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(COMBINED, (match, ...groups) => {
    // groups[i] is defined for whichever alternative matched.
    const i = groups.findIndex((g, idx) => idx < RULES.length && g !== undefined);
    const rule = RULES[i] || RULES[RULES.length - 1];
    if (rule.kind === 'google id' && isDescriptiveName(match)) {
      review.push(`descriptive name kept as-is: "${match}"`);
      return match;
    }
    note(rule.kind, match);
    return rule.placeholder;
  });
}

function walk(node) {
  if (Array.isArray(node)) return node.map(walk);
  if (node === null || typeof node !== 'object') return scrubString(node);

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'credentials' && value && typeof value === 'object') {
      // Keep the credential TYPE (it documents what the node needs) but drop the
      // instance-specific id and the human-assigned account name.
      out[key] = Object.fromEntries(
        Object.entries(value).map(([credType, cred]) => {
          note('credential', cred && cred.id);
          return [credType, { id: PLACEHOLDER.credentialId, name: `Your ${credType} credential` }];
        })
      );
      continue;
    }

    if (key === 'webhookId') {
      note('webhookId', value);
      out[key] = PLACEHOLDER.webhookId;
      continue;
    }

    // Structural keys, never instance data — and every one of them is long enough to
    // trip GOOGLE_ID, which would quietly corrupt the export:
    //   `id`   canvas-local UUIDs. Meaningless off this instance, but they must stay
    //          DISTINCT; collapsing them to one placeholder makes n8n reject the import
    //          on duplicate ids.
    //   `type` node types like `...langchain.textSplitterRecursiveCharacterTextSplitter`.
    //          The word boundary falls after the final dot, so the bare type name is
    //          matched on its own and the node becomes an unresolvable type.
    // The genuinely sensitive `id`s live under `credentials` and the top-level workflow
    // id, both handled separately.
    if (STRUCTURAL_KEYS.has(key) && typeof value === 'string') {
      out[key] = value;
      continue;
    }

    // A channelId that is neither an expression nor ID-shaped is a channel *name*,
    // which the shape-based regexes cannot distinguish from prose.
    if (key === 'channelId' && value && typeof value === 'object' && typeof value.value === 'string') {
      const v = value.value;
      if (v && !v.startsWith('=') && !isIdShaped(v)) {
        review.push(`channel name at channelId: "${v}"`);
      }
    }

    // The same keys also occur as bare strings rather than resource-locator objects
    // (the publish payload carries `workflowId` that way). A 16-char n8n id clears no
    // shape rule here — GOOGLE_ID needs 25 — so without this branch it passes straight
    // through untouched.
    if (N8N_RESOURCE_KEYS.has(key) && typeof value === 'string') {
      note(`${key} ref`, value);
      out[key] = key === 'workflowId' ? PLACEHOLDER.workflowId : PLACEHOLDER.dataTableId;
      continue;
    }

    // Sub-workflow and data-table references point at resources on the same instance.
    if (N8N_RESOURCE_KEYS.has(key) && value && typeof value === 'object' && 'value' in value) {
      note(`${key} ref`, value.value);
      const placeholder = key === 'workflowId' ? PLACEHOLDER.workflowId : PLACEHOLDER.dataTableId;
      const next = { ...value, value: placeholder };
      // cachedResultName echoes the human-readable resource name from the instance.
      if ('cachedResultName' in next) next.cachedResultName = placeholder;
      out[key] = next;
      continue;
    }

    out[key] = walk(value);
  }
  return out;
}

function main() {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg) {
    console.error('Usage: node tools/sanitize-n8n-export.js <input.json> [output.json]');
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(
    outputArg || inputPath.replace(/(\.json)?$/i, '.sanitized.json')
  );

  const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  // Node ids are canvas-local and harmless; the top-level workflow id is not.
  const cleaned = walk(source);
  const dropped = INSTANCE_STATE_KEYS.filter((k) => k in cleaned);
  for (const key of dropped) delete cleaned[key];
  cleaned.active = false;

  fs.writeFileSync(outputPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');

  const counts = findings.reduce((acc, f) => {
    const kind = f.split(':')[0];
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});

  console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
  console.log('Redacted:');
  for (const [kind, n] of Object.entries(counts).sort()) {
    console.log(`  ${String(n).padStart(4)}  ${kind}`);
  }
  if (!findings.length) console.log('  (nothing matched — double-check the input is a real export)');

  if (dropped.length) console.log(`Dropped instance state: ${dropped.join(', ')}`);

  if (review.length) {
    console.log('\nNEEDS A HUMAN LOOK (not auto-replaced — too ambiguous to do safely):');
    for (const r of [...new Set(review)]) console.log(`  - ${r}`);
  }

  console.log('\nRead the output before committing. This catches the known shapes, not every possible one.');
}

main();
