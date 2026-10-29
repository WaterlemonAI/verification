export async function recoverCaseRetirements({ usageStore, caseStore, maxWorkspaces = 4, rowsPerWorkspace = 10_000 }) {
  const tasks = await caseStore.pendingRetirements(maxWorkspaces);
  const result = { scanned: tasks.length, completed: 0, continuing: 0, errors: 0 };
  for (const task of tasks) {
    try {
      const policy = await usageStore.casePolicy(task.workspaceId);
      if (policy.visible_from_version < task.beforeVersion) {
        // The task was written before the policy transaction; discard a failed update after its version moved on.
        const stale = policy.version >= task.beforeVersion
          || Date.now() - Date.parse(task.createdAt) > 60 * 60 * 1000;
        await caseStore.advanceRetirementTask(task, { done: stale, cursor: task.cursor });
        continue;
      }
      const page = await caseStore.retireWorkspaceCases(task.workspaceId, task.beforeVersion,
        { cursor: task.cursor, limit: rowsPerWorkspace });
      await caseStore.advanceRetirementTask(task, page);
      if (page.done) result.completed++;
      else result.continuing++;
    } catch {
      result.errors++;
      await caseStore.advanceRetirementTask(task, { done: false, cursor: task.cursor }, { delayMs: 5 * 60_000 }).catch(() => {});
    }
  }
  return result;
}
