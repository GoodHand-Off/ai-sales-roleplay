/** Next.js calls this once when a server process starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupChecks } = await import("./lib/startup");
  await runStartupChecks();
}
