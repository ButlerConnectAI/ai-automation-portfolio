# AI Automation Portfolio — Jacob Butler

Production AI agents and automation, built end to end. This repo holds the working
artifacts: importable workflow definitions, architecture write-ups, and the design
reasoning behind them — including the parts that went wrong first.

Denver, CO · [linkedin.com/in/butler-jacob](https://linkedin.com/in/butler-jacob)

## Projects

### [Tune-Resume](./tune-resume) — job description in, tailored resume out

A 57-node n8n pipeline. Drop a job posting into Slack as a PDF, Google Doc link, job
board URL or pasted text; it reads your career source material from Google Drive,
drafts a tailored resume constrained to facts you actually have, benchmarks the draft
against comparable live postings, and comes back in-thread with proposed changes for
your approval before publishing formatted Word and PDF output to Drive.

The interesting part isn't the drafting — it's the constraint that every claim must
trace to source material, and what it took to make that hold. The write-up covers two
failures of that constraint. The [first](./tune-resume#the-bug-that-shaped-the-design):
the review stage quietly reintroduced claims the writer had correctly refused to make,
why a prompt rule didn't stop it, and the schema-level fix that did. The
[second](./tune-resume#the-second-bug-a-rule-scoped-to-the-wrong-document): a skills
claim with no supporting evidence anywhere on the page, because the no-fabrication rule
was scoped to the source corpus rather than to the document a recruiter actually reads.

A companion [interview loop](./tune-resume#closing-the-loop-interviewing-for-the-missing-facts)
closes the upstream hole behind both. The pipeline always knew what your material was
missing — it just had nowhere to put that knowledge, so it rediscovered and discarded the
same gaps on every run. Typing `facts` in the channel now asks about them and writes your
answers permanently back into the source material.

**Stack:** n8n · OpenAI · Firecrawl · Slack · Google Drive/Docs APIs · Data Tables ·
built with Claude Code

### [Gadgets & More](./gadgets-and-more) — policy-grounded support email drafting

Two n8n workflows for a retail support desk. A nightly job keeps a Supabase vector store
in sync with the policy documents in Google Drive; a polled agent reads the support inbox,
answers strictly from what it retrieves, and leaves a Gmail draft in-thread for a human to
review — it never sends. Low-confidence answers are flagged as such in Slack rather than
dressed up as certainty.

The parts worth reading are the ones that make an unattended loop safe: the Gmail label
that is simultaneously the trigger filter and the loop guard, the
[three-way triage](./gadgets-and-more#design-decisions-worth-explaining) that declines to
reply at all, and the idempotent re-ingest that keeps a nightly rebuild from quietly
filling the knowledge base with duplicates.

**Stack:** n8n · OpenAI · Supabase pgvector · Postgres · Gmail/Drive APIs · Slack ·
built with Claude Code

## How I build

- **Claude Code** — design and build, end to end. Everything in this repo.
- **Microsoft Copilot Studio / Azure OpenAI / Azure AI Foundry** — production agents in
  a regulated financial services environment. That work is proprietary and isn't here.
- **Orchestration:** n8n, Zapier. **Integration:** REST, webhooks, OData, MCP.
- **Multi-agent:** orchestrator plus specialist agents, wired to structured data over MCP.

## On publishing workflow exports

Raw n8n exports are not safe to commit. They carry credential IDs, webhook IDs, Slack
channel IDs, and Google Drive file IDs that resolve to real documents. Everything here
is run through [`tools/sanitize-n8n-export.js`](./tools/sanitize-n8n-export.js) first,
which replaces those with placeholders while keeping credential *types* intact so the
workflow still documents what it needs. Git history is permanent — that has to happen
before the first commit, not after.

```bash
node tools/sanitize-n8n-export.js path/to/export.json
```

One gotcha worth knowing if you borrow the script: **the REST API and the editor's
Download button do not return the same thing.** On n8n versions with the draft/publish
model, `GET /workflows/:id` includes an `activeVersion` block holding a second full copy
of every node plus a publish history stamped with a real user ID — roughly half the
export by weight, and invisible if you only ever exported from the UI. The sanitizer
drops that block along with the other instance state rather than trying to scrub it,
since n8n only needs `name`, `nodes`, `connections` and `settings` to import.
