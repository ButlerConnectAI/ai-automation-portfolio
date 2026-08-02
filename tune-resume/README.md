# Tune-Resume — job description in, tailored resume out

Drop a job posting into a Slack channel — a PDF, a Google Doc link, a job-board URL,
or just pasted text — and about ninety seconds later the thread comes back with a
critique of the draft it wrote, a checklist of proposed changes, and a request for
your approval. Approve what you want, and it publishes a formatted Word and PDF
resume into a per-company folder in Google Drive.

57 nodes, plus a companion interview loop that keeps the fact base it draws from
honest. Built in n8n with Claude Code.

## The problem it solves

Tailoring a resume per application is the advice everyone gives and nobody follows,
because doing it honestly takes 45 minutes and doing it dishonestly takes five. The
dishonest version is what most AI resume tools automate: feed them a posting and they
hand back a document confidently claiming you have whatever the posting asked for.

The design constraint here is the opposite one. **Every claim on the output must trace
back to a fact in the candidate's own source material.** Reordering, reweighting and
rewording real experience is the entire product. Inventing a line of it is a defect.

That constraint is why this is more than a prompt.

## Architecture

```mermaid
flowchart TD
    A[Slack message] --> B{Bot / noise filter}
    B --> C{Route by input type}
    C -->|file attachment| D[Convert File To Text]
    C -->|Google Doc link| D
    C -->|job board URL| E[Firecrawl scrape]
    C -->|pasted text| F[Normalize JD]
    D --> F
    E --> G{Scrape usable?}
    G -->|thin shell| X[Report failure in thread]
    G -->|ok| F
    F --> H{Extraction succeeded?}
    H -->|no| X
    H -->|yes| I[Acknowledge in thread]
    I --> J[List Drive source files]
    J --> K[Filter scaffolding + supported types]
    K --> L[Convert each to text]
    L --> M[Build corpus — near-duplicate detection]
    M --> N[Analyze JD against profile<br/>structured extraction]
    N --> O[Write tailored resume<br/>evidence-constrained]
    O --> P[Search comparable postings]
    P --> Q[Count keyword demand mechanically]
    Q --> R[Benchmark and critique<br/>evidence-gated recommendations]
    R --> S[(Stash review state<br/>Data Table)]
    S --> T[Post critique + approval form]
    T -.execution pauses.-> U[Restore review state]
    U --> V{Any changes approved?}
    V -->|yes| W[Apply approved revisions]
    V -->|no| Y[Select final resume]
    W --> Y
    Y --> Z[Style HTML → Drive → Google Doc<br/>→ Word + PDF → per-company folder]
    Z --> AA[Post result in thread]
```

## Design decisions worth explaining

**Four input routes converge on one node.** A file, a Drive link, a scraped URL and
pasted text all produce different shapes. `Normalize JD` collapses them with a single
coalescing expression rather than four parallel downstream branches. Adding a fifth
input type means adding one route, not duplicating a pipeline.

**The scraper is assumed to fail.** LinkedIn and Indeed block scrapers or wall them
behind a login, and what comes back is a cookie banner, not a job posting. A length
check catches the thin shell and reports it in-thread instead of tailoring a resume
against boilerplate.

**Anti-loop guard on the trigger.** The workflow posts into the same Slack channel it
listens to. Without a `bot_id` check on the very first filter, its own thread replies
re-trigger it, forever. This is the kind of thing you find in production, once.

**State survives the pause.** The Slack approval step suspends the execution, possibly
for hours. n8n does not restore pre-pause run data when a `sendAndWait` execution
resumes, so any `$('UpstreamNode')` reference across that boundary silently breaks.
Everything the second half needs is serialized into a Data Table row before the pause
and read back after it.

**Near-duplicate detection on the source corpus.** The Drive folder accumulates copies
of the same facts file — a Google Doc and a markdown export, differing in bullet
glyphs, line endings, and usually a few edits. Exact-match dedupe misses all of them.
Trigram Jaccard at 0.9 catches them and keeps the longer copy.

**Keyword demand is counted, not guessed.** Before the critique runs, the workflow
pulls comparable live postings and counts, mechanically, how many of them mention each
keyword. The reviewer is handed those counts as fact and told to cite them as given.
An LLM asked to estimate market demand will produce a confident number; this produces
a real one.

## The bug that shaped the design

The first version had a clean writer and a reviewer that graded its output against
market research. Run against a real posting, the writer behaved — it respected the
gap list and omitted what the source material didn't support.

The reviewer then put it all back.

It returned recommendations like *"Add the phrase 'Product Management and roadmap
ownership experience' to the summary — Product Management appears in 2/5 comparable
postings."* The candidate material never claimed product management anywhere, and the
upstream analysis had already flagged it as a gap. Six more recommendations in the
same shape followed, and each one landed in the final document verbatim.

Three things had to be true at once for that to happen:

1. **The no-fabrication rule was scoped to the wrong things.** It banned inventing a
   *skill, employer, title, date, metric or certification* — a list of nouns. The
   recommendations proposed *wording*, so nothing in the rule applied.
2. **The reviser had no way to check.** By design it never receives the corpus; its
   prompt says its only facts are the draft plus anything quoted inside the change
   details. So an asserted phrase in a recommendation was, structurally, a licensed
   fact. The critique was trusted as a source with nothing verifying it.
3. **The schema demanded at least four recommendations.** A floor on the output is a
   quota, and a model that has run out of honest suggestions will meet a quota with
   dishonest ones.

The fix is structural rather than another instruction:

- Every recommendation now requires a **`source_quote`** — verbatim text from the
  candidate material that already states the claim. A required field in the output
  schema is a shape the model has to fill; a rule in a prompt is a request it can
  drift from.
- The quote travels inside the recommendation detail, so the reviser — which still
  never sees the corpus — finally has real evidence rather than an assertion.
- The upstream gap list is passed into the reviewer as authoritative, with an explicit
  instruction never to recommend re-adding anything on it.
- The minimum went from four to zero, with the prompt stating that two well-evidenced
  recommendations, or none at all, is a correct outcome.
- The approval card in Slack now shows the supporting quote under each proposed change,
  so a weak one is visibly rejectable before it reaches the document.

The general lesson: **a guardrail written as a list of nouns will be walked around by
anything not on the list, and a downstream stage that cannot verify its input will
launder whatever the upstream stage asserts.** Putting the evidence requirement in the
schema rather than the prompt is what actually closed it.

## The second bug: a rule scoped to the wrong document

The schema fix held. Every recommendation that reached the document carried a verbatim
quote from the candidate's own material. A later run still produced a resume with a
Core Skills line reading *"Consulting and client-facing delivery in regulated
industries"* — and nothing in the experience section below it supported the claim.

The two most recent roles described no client work at all. The only client-facing
evidence sat in roles that ended in 2020 and 2018, at the bottom of the page. And the
qualifier turned out to be assembled from two different employers: *client-facing* came
from one, *regulated industry* from another. No single role evidenced the combination.

Every stage had behaved correctly by its own rules:

1. **The no-fabrication rule is scoped to the corpus, not the page.** Both writer prompts
   say the source material is the only permissible fact base — and the skill was, in
   fact, supported somewhere in it. But a claim can be entirely true in the corpus and
   have no bullet on the page demonstrating it. A recruiter reads the page.
2. **"Surface X more prominently" has no lower bound.** The reviser satisfied a
   recommendation to emphasise consulting experience the cheapest way available: it added
   a line to a skills list. Rewriting an experience bullet would have required facts it
   structurally cannot see, so the weakest compliant action was the only one open to it.

The fixes push the constraint down to the artifact the reader actually sees:

- Core Skills must be demonstrable from a Professional Experience bullet **in the same
  document**. If a skill is real in the corpus but no bullet shows it, the writer either
  writes that bullet or drops the skill.
- A qualifier may only combine attributes that **co-occur within a single role**.
  Welding *client-facing* from one employer onto *regulated* from another is fabrication
  even when both halves are independently true.
- The reviser now reads `surface` / `highlight` / `emphasise` as an instruction to rewrite
  an existing bullet, and skips the change entirely when no bullet supports it.

**A separate reporting bug made this much harder to see.** The Slack summary headed
*"Evidenced strengths I led with"* was printing each match's `requirement` field — the
job posting's own wording — instead of its `evidence` field, the candidate's actual fact.
The resume was being built from the right data the whole time; the report describing it
was reading the wrong column, so a working pipeline looked like it had ignored the source
material entirely. **A report that misdescribes correct output costs exactly as much
trust as a real defect, and is harder to find because the artifact is fine.**

The second lesson, then: **a constraint is only as strong as the document it is scoped
to.** Anchoring "no unsupported claims" to the corpus left the page unguarded, because
the page is a lossy projection of the corpus and the guarantee did not survive the
projection.

## Closing the loop: interviewing for the missing facts

Both bugs above are downstream symptoms of one upstream fact: the pipeline could detect
what was missing but had no way to ask for it. `Analyze JD Against Profile` produces a
`gaps` array on every run, the writer is told to omit anything on it, and the candidate
sees the list only in the final Slack message — after the resume is already published.
Nothing ever flowed back. The same gap was rediscovered, reported and discarded on every
subsequent run.

A conversational assistant closes this trivially: it notices the hole and asks. A
one-shot pipeline cannot, so the interview runs as its own workflow.

```mermaid
flowchart TD
    A["Slack message: facts"] --> B{Command filter<br/>under 120 chars}
    B --> C[Read Drive source material<br/>same corpus the resumes use]
    C --> D[Find weak spots<br/>vague claims, absent scope, thin recent roles]
    D --> E{Anything worth asking?}
    E -->|no| F[Report nothing to ask]
    E -->|yes| G[(Stash questions<br/>Data Table)]
    G --> H[Post questions + form]
    H -.execution pauses.-> I[Restore questions]
    I --> J{Any answers given?}
    J -->|no| K[Report nothing written]
    J -->|yes| L[Record Interview Answers<br/>sub-workflow]
    L --> M[Append to master facts<br/>read-modify-write on Drive]
    M --> N[Confirm in thread]
```

**Why it is a separate workflow rather than a stage in the pipeline.** The obvious design
puts the interview between analysis and drafting, so the writer has the answers before it
writes. That placement is correct and was rejected anyway. n8n drops all pre-pause run
data when a `sendAndWait` execution resumes — the same constraint the Data Table stash
already works around for the approval gate. Inserting a *second* pause upstream would
break every `$('UpstreamNode')` reference that crosses it, which is most of the second
half of a 57-node workflow. The cost of correct placement was a refactor of roughly half
the pipeline; the cost of separate placement is that answers improve the *next* run
rather than the current one. For a fact base that is written once and read on every
application, that trade is heavily one-sided.

**Both workflows watch the same Slack channel without conflicting.** The pipeline's noise
filter already required 120+ characters or a file attachment, because a job description is
never shorter than that. The interview's filter requires the message be *under* 120
characters. The two predicates are provably disjoint, so a command and a job posting can
share one channel with no router between them and no change to the existing workflow.

**The questions are constrained against leading the witness.** *"Do you have client-facing
experience?"* invites a yes and teaches the system nothing. The prompt requires questions
that name a specific missing thing and ask for employer, action and rough date — and
forbids suggesting an answer, proposing wording, or hinting at what a good answer looks
like. An interview that coaches produces a fabricated resume two stages later.

The write-back is read-modify-write against the same Drive file ID, so version history
retains every prior revision. It refuses to write when the read comes back empty — a
transient Drive failure would otherwise replace an entire career history with a handful
of interview answers.

## Running it

The published export has all instance-specific identifiers replaced with
`REPLACE_WITH_YOUR_*` placeholders. To run it you need:

| What | Used for |
|---|---|
| n8n (self-hosted or cloud) | The runtime. Data Tables must be available. |
| Slack app | Trigger channel, thread replies, and the approval form |
| Google Drive + Docs OAuth | Reading source material, writing Word/PDF output |
| OpenAI API key | Extraction, drafting, critique |
| Firecrawl API key | Scraping postings and comparable-role research |
| A `Convert File To Text` sub-workflow | PDF/DOCX/Doc → text |

Then:

1. Import the three exports in `workflows/`:

   | File | What it is |
   |---|---|
   | `tune-resume.sanitized.json` | The main pipeline — job description in, resume out |
   | `interview-fill-gaps.sanitized.json` | The `facts` interview loop |
   | `record-interview-answers.sanitized.json` | Sub-workflow: appends answers to the master facts file |

2. Replace every `REPLACE_WITH_YOUR_*` placeholder — credentials, the Slack channel ID,
   the Drive source folder ID, the output folder ID, and the sub-workflow references.
   Both the interview and the pipeline reference `Convert File To Text`; the interview
   additionally references `Record Interview Answers`.
3. Put your career source material in the Drive source folder. Files named `README*`,
   `AGENT_INSTRUCTIONS*`, `STYLE_RULES*` or `SAMPLE_RESUME*` are deliberately excluded
   from the corpus — that filter exists so guidance-to-self doesn't get read as career
   fact and end up on the resume.
4. Activate all three, then:
   - type `facts` in the channel to be interviewed about what your material is missing;
   - drop a job posting in the same channel to get a resume.

Both workflows listen to the same channel. The pipeline ignores anything under 120
characters and the interview ignores anything over it, so no router is needed between
them.

## Stack

n8n · OpenAI (extraction, drafting, critique) · Firecrawl · Slack · Google Drive and
Docs APIs · n8n Data Tables · built with Claude Code
