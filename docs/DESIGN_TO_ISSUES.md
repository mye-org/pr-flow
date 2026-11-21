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
