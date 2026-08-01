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
trace to source material, and what it took to make that hold. The
[write-up](./tune-resume#the-bug-that-shaped-the-design) covers the failure where the
review stage quietly reintroduced claims the writer had correctly refused to make, why
a prompt rule didn't stop it, and the schema-level fix that did.

**Stack:** n8n · OpenAI · Firecrawl · Slack · Google Drive/Docs APIs · Data Tables ·
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
