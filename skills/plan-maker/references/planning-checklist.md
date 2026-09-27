# Planning Checklist

## Plan checks

- [ ] **Schema:** Fields and options match current `planweave schema manifest --json` and relevant command help.
- [ ] **Scope and graph:** Canvas/task/block structure matches the requested scope; dependencies represent actual prerequisites and integration gates.
- [ ] **Parallelism:** `execution.parallel.enabled`, `maxConcurrent`, first-batch candidates and dispatch mode are specified; shared writes and environment use have workable coordination.
- [ ] **Execution:** Effective executor, transport, task/block overrides, custom profiles and required capabilities match the execution environment.
- [ ] **Review:** Review gates, required status, feedback limits, completion policy and applicable presets/hooks fit the task's risk.
- [ ] **Prompts:** Actual inheritance includes shared rules, task acceptance and block instructions in the rendered prompts.
- [ ] **Acceptance:** Each block has concrete implementation boundaries, test cases and observable pass criteria; UI changes include actual interaction acceptance.
- [ ] **Package:** Referenced prompts exist, configuration matches the graph, and the package passes the checks below.

## Conditional checks

- **Shared files or environments:** Specify ownership, isolation or exclusive use and a suitable concurrency limit. Block `parallel.sharedResources` supplies coordination hints; dependencies and execution settings control scheduling.
- **Custom executors:** Check supported profile fields, CLI/ACP transport, registration/trust and relevant limits. Resolve block → task → package → runtime defaults, including any execution-time override.
- **Capability requirements:** `requirements.capabilities` uses portable tokens supported by the execution environment. Concrete Host/human assignment belongs to execution configuration outside the package; tool requirements belong in block instructions and acceptance.
- **Review blocks:** Check package/block feedback limits, `required`, completion policy, `preset`, `triggerCondition`, `inputContext`, `passCriteria`, `feedbackFormat`, and `hook`. Define pass criteria and the `needs_changes` feedback path.
- **UI changes:** Specify app/build, environment, interaction steps, expected final states and evidence. Use the user-specified acceptance tool, including @电脑 when requested.

## Package verification

Scope commands to each edited canvas using current CLI help.

- Validate edited canvases; validate the project when canvas registration or project dependencies changed. Check graph quality against the selected review/gate policy.
- Preview scheduling with `claim-next --dry-run`, adding `--parallel` for parallel dispatch. Compare candidates, available capacity, effective executors and blockers with the graph; inspect `status` / `explain` for discrepancies.
- Render each affected block with `prompt <task#block>`; check inherited requirements, test commands and acceptance tools.
- When Desktop is available, inspect task/block coverage, dependency edges and readable layout.
