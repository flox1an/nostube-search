# Agent Workflow: Planner → Workers → Reviewer Loop

This project uses a **pi subagent chain** workflow for structured feature development:
**Planner → Parallel Workers → Reviewer Loop**.

## Agent Configuration

Defined in `.pi/settings.json`:

| Agent | Model | Thinking | Purpose |
|-------|-------|----------|---------|
| `planner` | `routstr/deepseek-v4-pro` | default | Creates structured implementation plans |
| `worker` | `openai-codex/gpt-5.3-codex` | medium | Implements code changes |
| `reviewer` | `openai-codex/gpt-5.5` | high | Reviews diffs for correctness & quality |
| `scout` | `routstr/glm-4.7` | default | Fast codebase recon / context gathering |

## Workflow Pattern

Each feature or non-trivial change follows this loop:

```
1. PLAN → planner produces a plan with independent task groups
2. IMPLEMENT → parallel workers execute each group concurrently
3. REVIEW → reviewer(s) inspect the resulting diff
4. FIX → worker applies reviewer feedback
5. REPEAT from 3 if needed, or DONE
```

### Phase 1: Planning

Use the `planner` agent to decompose work into independent, parallelizable groups.
Each group must work on **disjoint file paths** to avoid conflicts.

```typescript
subagent({
  agent: "planner",
  task: `Create an implementation plan for: <feature description>

The plan MUST split into N independent, parallel-executable task groups.
Each group works on disjoint files - no overlap. List exact file paths.

### Group A: <name>
- files: ...
- tasks: ...

### Group B: <name>
- files: ...
- tasks: ...`
})
```

### Phase 2: Parallel Implementation

After the plan is approved, use a chain with one planner step followed by parallel workers.
Each worker receives `{previous}` (the plan) and is told which group to implement.

```typescript
subagent({
  chain: [
    // Step 1: Planner
    {
      agent: "planner",
      task: "..."
    },
    // Step 2: Parallel workers
    {
      parallel: [
        {
          agent: "worker",
          task: "Implement Group A from:\n{previous}",
          output: "group-a-done.md",
          outputMode: "file-only"
        },
        {
          agent: "worker",
          task: "Implement Group B from:\n{previous}",
          output: "group-b-done.md",
          outputMode: "file-only"
        }
      ],
      concurrency: 3
    }
  ],
  context: "fresh",
  async: true
})
```

### Phase 3: Review

After implementation, run fresh-context reviewers with distinct angles:

```typescript
subagent({
  tasks: [
    {
      agent: "reviewer",
      task: "Review the current diff for correctness and regressions.",
      output: false
    },
    {
      agent: "reviewer",
      task: "Review the current diff for simplicity and maintainability.",
      output: false
    }
  ],
  concurrency: 2,
  context: "fresh",
  async: true
})
```

### Phase 4: Fix Worker

Apply synthesized reviewer feedback:

```typescript
subagent({
  agent: "worker",
  task: `Apply the following reviewer fixes. Only fix issues worth doing now.

<reviewer synthesis>`,
  async: true
})
```

## Key Rules

1. **Disjoint files** — parallel workers must never edit the same files. Enforce this in the plan.
2. **Async by default** — always use `async: true`. The parent continues working (or waits) as needed.
3. **Fresh context for reviewers** — always `context: "fresh"` so reviewers inspect the actual code, not inherited history.
4. **File-only output** — use `outputMode: "file-only"` for large worker summaries to keep the chat clean.
5. **Nostube parsing** — video event parsing must match `extractVideoMeta` from `../nostube/server/meta.ts`:
   - Thumbnail priority: `thumb` > `image` > `imeta` image URLs
   - `imeta` tags provide `url`, `m` (MIME), `dim` (dimensions), `image`
   - Summary from tag `summary` or `event.content`
   - Video URL from `imeta` (video MIME) or fallback `url` tag
   - Author pubkey should be npub-encoded

## Template: New Feature

```typescript
subagent({
  chain: [
    { agent: "planner", task: "Plan for: <feature>" },
    { parallel: [
      { agent: "worker", task: "Part A:\n{previous}", output: "part-a.md", outputMode: "file-only" },
      { agent: "worker", task: "Part B:\n{previous}", output: "part-b.md", outputMode: "file-only" }
    ], concurrency: 2 }
  ],
  context: "fresh",
  async: true
})
// After it completes, run parallel reviewers:
subagent({
  tasks: [
    { agent: "reviewer", task: "Review the diff for correctness.", output: false },
    { agent: "reviewer", task: "Review the diff for simplicity.", output: false }
  ],
  context: "fresh",
  async: true
})
```

## Template: Quick Fix (Single Agent)

```typescript
subagent({
  agent: "worker",
  task: "Fix: <description>",
  async: true
})
```

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `flox1an/nostube-search`. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
