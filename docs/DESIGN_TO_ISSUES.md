# Design to Issues (`plan-manifest.yml`)

`pr-flow` can materialize an entire Agile hierarchy (Epic → Stories → Tasks/Bugs + native `blocked_by` dependencies) from a declarative YAML manifest.

## 1. Authoring `plan-manifest.yml`

See [`templates/plan-manifest.example.yml`](../templates/plan-manifest.example.yml) for a complete example:

```yaml
version: 1
epic:
  id: epic-auth
  title: "Epic: User Authentication"
  body: "End-to-end authentication"

issues:
  - id: story-core
    title: "Story: Token Service"
    type: story
  - id: task-jwt
    title: "Implement JWT signing"
    type: task
    parentId: story-core
  - id: task-middleware
    title: "Add auth middleware"
    type: task
    parentId: story-core
    blockedBy:
      - task-jwt
```

## 2. Manifest Rules

- `epic` is optional; when present, top-level `issues` without `parentId` are automatically linked as sub-issues of `epic`.
- Each issue supports optional `body`, `parentId`, `blockedBy` (must form a DAG), and `labels: [...]`.
- `materialize` automatically appends `## Development Standards` to every issue body unless `## Development Standards` is already present in `body`.
- Leaf issues with `blockedBy` entries are initialized with `pr-flow-status` = `blocked-dep`; unblocked leaf issues start at `ready`; container issues (`epic` or `story` with children) start at `backlog`.

## 3. Validate & Materialize

```bash
# Validate schema and ensure the dependency graph is a DAG (no cycles or dangling IDs)
pr-flow plan validate --file plan-manifest.yml

# Create issues in topological order, link sub_issues, and attach blocked_by dependencies
GITHUB_TOKEN=$(gh auth token) pr-flow plan materialize --file plan-manifest.yml --repo <owner>/<repo>
```

## 4. Decomposition & Spec Authoring Guidelines

To keep PRs small without turning `plan-manifest.yml` into over-specified pseudocode:

1. **Slice vertically along natural seams:** Split by independent user behavior, CLI command, adapter, or bug—not by horizontal code layers that cannot be tested independently.
2. **Write contract-scoped leaf bodies:** Specify **behavior, boundary contracts, and acceptance tests**; let the executing agent choose internal file layout and helper structure within `AGENTS.md` / `## Development Standards`.
   - *Over-specified:* `"Create src/auth/jwt.ts exporting signJwt() using jose and private helper parseExp()..."`
   - *Contract-scoped:* `"Issue and verify short-lived signed access tokens for a user ID; cover expiry and invalid-signature rejection in unit tests."`
3. **Keep tightly coupled stories as a single leaf:** A `type:story` with **0** sub-issues is an executable leaf. Do not split a cohesive change into multiple tasks if doing so forces you to spell out internal DTOs between them.
4. **Plan in rolling waves:** Materialize only the initial wave (or a **contract-first** leaf defining shared types/interfaces) plus high-level parent `story` containers. Decompose later waves after upstream PRs merge to `baseBranch` so the codebase—not Markdown—defines internal interfaces.

