export async function recoverCaseRetirements({ usageStore, caseStore, maxWorkspaces = 4, rowsPerWorkspace = 10_000 }) {
  const tasks = await usageStore.pendingCaseRetirements(maxWorkspaces);
  const result = { scanned: tasks.length, completed: 0, continuing: 0, errors: 0 };
  for (const task of tasks) {
    try {
      const page = await caseStore.retireWorkspaceCases(task.workspaceId, task.beforeVersion,
        { cursor: task.cursor, limit: rowsPerWorkspace });
      const updated = await usageStore.recordCaseRetirementProgress(task.workspaceId, task.beforeVersion, page);
      if (!updated) continue; // A newer policy has its own visibility floor and starts a fresh scan.
      if (page.done) result.completed++;
      else result.continuing++;
    } catch {
      result.errors++;
      await usageStore.recordCaseRetirementProgress(task.workspaceId, task.beforeVersion,
        { done: false, cursor: task.cursor }).catch(() => {});
    }
  }
  return result;
}
