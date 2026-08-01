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
const SLACK_CHANNEL = /\bC[A-Z0-9]{8,}\b/g;
const SLACK_TEAM = /\bT[A-Z0-9]{8,}\b/g;
const BEARERISH = /\b(fc-|sk-|xox[baprs]-|ghp_|gho_)[A-Za-z0-9_-]{10,}/g;

const PLACEHOLDER = {
  credentialId: 'REPLACE_WITH_YOUR_CREDENTIAL_ID',
  webhookId: 'REPLACE_WITH_YOUR_WEBHOOK_ID',
  googleId: 'REPLACE_WITH_YOUR_GOOGLE_FILE_ID',
  slackChannel: 'REPLACE_WITH_YOUR_SLACK_CHANNEL_ID',
  slackTeam: 'REPLACE_WITH_YOUR_SLACK_TEAM_ID',
  token: 'REPLACE_WITH_YOUR_TOKEN',
  workflowId: 'REPLACE_WITH_YOUR_WORKFLOW_ID',
};

const findings = [];
const note = (kind, value) => {
  findings.push(`${kind}: ${String(value).slice(0, 12)}…`);
};

// Things too ambiguous to auto-replace without mangling legitimate text, but which
// a human should look at before publishing. Channel *names* are the common case:
// "urgent-email-errors" is indistinguishable from prose to a regex, but it still
// leaks internal naming.
const review = [];

function scrubString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(BEARERISH, (m) => (note('token', m), PLACEHOLDER.token))
    .replace(SLACK_CHANNEL, (m) => (note('slack channel', m), PLACEHOLDER.slackChannel))
    .replace(SLACK_TEAM, (m) => (note('slack team', m), PLACEHOLDER.slackTeam))
    .replace(GOOGLE_ID, (m) => (note('google id', m), PLACEHOLDER.googleId));
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

    // A channelId that survived the ID regexes is a channel *name*, not an id.
    if (key === 'channelId' && value && typeof value === 'object' && typeof value.value === 'string') {
      const v = value.value;
      if (v && !v.startsWith('=') && !v.startsWith('REPLACE_WITH_')) {
        review.push(`channel name at channelId: "${v}"`);
      }
    }

    // Sub-workflow references point at another workflow on the same instance.
    if (key === 'workflowId' && value && typeof value === 'object' && 'value' in value) {
      note('sub-workflow ref', value.value);
      out[key] = { ...value, value: PLACEHOLDER.workflowId };
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
  delete cleaned.id;
  delete cleaned.versionId;
  delete cleaned.meta;
  delete cleaned.pinData;
  delete cleaned.staticData;
  delete cleaned.shared;
  delete cleaned.triggerCount;
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

  if (review.length) {
    console.log('\nNEEDS A HUMAN LOOK (not auto-replaced — too ambiguous to do safely):');
    for (const r of [...new Set(review)]) console.log(`  - ${r}`);
  }

  console.log('\nRead the output before committing. This catches the known shapes, not every possible one.');
}

main();
