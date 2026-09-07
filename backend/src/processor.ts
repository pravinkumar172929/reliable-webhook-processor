export async function runSimulation(
  data: any,
  attemptNumber: number
): Promise<void> {
  const sim = data?.simulate ?? "ok";

  if (sim === "ok") return;

  if (sim === "always_fail") {
    throw new Error("always_fail: simulated permanent failure");
  }

  const failThenMatch = /^fail_then_succeed:(\d+)$/.exec(sim);
  if (failThenMatch) {
    const n = parseInt(failThenMatch[1], 10);
    if (attemptNumber <= n) {
      throw new Error(
        `fail_then_succeed: failing attempt ${attemptNumber} of ${n}`
      );
    }
    return;
  }

  const slowMatch = /^slow:(\d+)$/.exec(sim);
  if (slowMatch) {
    const seconds = parseInt(slowMatch[1], 10);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return;
  }

  // Unrecognized simulate value: treat as ok rather than crash the worker.
  return;
}
