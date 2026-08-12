import { validateWorkflowManifest } from './capsule.js';
import { scopedReviewWorkflow } from './scoped-review.js';
function module(name, description, phases, maxAgents, patterns, source) {
    return {
        manifest: validateWorkflowManifest({
            name, description, phases, readOnly: true, maxAgents,
            maxConcurrency: Math.min(4, maxAgents),
            mayUseWorktree: false, patterns,
        }),
        execution: 'trusted-package',
        source,
    };
}
const parallelInvestigation = module('parallel-investigation', 'Investigate a question from independent angles, then synthesize evidence.', ['investigate', 'synthesize'], 8, ['fan-out-and-synthesize'], `async function run(wf, args) {
  const question = String(args?.question ?? args?.request ?? "Investigate the requested topic.");
  const targets = Array.isArray(args?.targets) && args.targets.length > 0 ? args.targets : ["structure, entry points, and control flow", "edge cases, error handling, and failure modes", "tests, validation, and existing coverage"];
  const rubric = String(args?.rubric ?? "Deduplicate overlapping findings, keep concrete evidence, rank by relevance, and explicitly note gaps left by failed investigations.");
  const requestedAgents = Number.isSafeInteger(args?.maxAgents) && args.maxAgents > 1 ? args.maxAgents : 8;
  const selected = targets.slice(0, Math.min(7, requestedAgents - 1));
  const concurrency = Number.isSafeInteger(args?.maxConcurrency) && args.maxConcurrency > 0 ? Math.min(4, args.maxConcurrency, selected.length) : Math.min(4, selected.length);
  const findingSchema = { type: "object", additionalProperties: false, required: ["finding"], properties: { finding: { type: "string" } } };
  return await wf.phase("investigate", async () => {
    const findings = await wf.parallel(selected.map((target, index) => async () => {
      try {
        const report = await wf.runAgent({
          name: "investigate-" + (index + 1),
          prompt: "Investigate this target independently and cite concrete evidence.\\nQuestion: " + question + "\\nTarget: " + String(target),
          readOnly: true,
          modelHint: "balanced",
          outputSchema: findingSchema
        });
        if (report === null) return { angle: String(target), status: "failed", text: "[investigation failed] agent did not complete" };
        const structured = report.structured && typeof report.structured.finding === "string" && report.structured.finding.trim().length > 0 ? report.structured.finding : undefined;
        const text = structured ?? (report.finalText.trim().length > 0 ? report.finalText : "[no finding text was returned]");
        return { angle: String(target), status: report.status === "completed" ? "completed" : "failed", text };
      } catch (error) {
        return { angle: String(target), status: "failed", text: "[investigation failed] " + String(error?.message ?? error) };
      }
    }), { concurrency });
    const accepted = findings.filter(Boolean);
    const synthesis = await wf.phase("synthesize", async () => await wf.synthesize({
      inputs: accepted.map((finding) => "### " + finding.angle + " (" + finding.status + ")\\n" + finding.text),
      rubric
    }));
    return { synthesis: synthesis.text, findings: accepted, degraded: accepted.some((finding) => finding.status !== "completed") };
  });
}`);
const patterns = [
    module('classify-and-act', 'Classify a request and route it to a specialized worker.', ['classify', 'act', 'synthesize'], 3, ['classify-and-act'], `async function run(wf, args) {
  const request = String(args?.request ?? args?.question ?? "Classify and handle the task.");
  const classification = await wf.phase("classify", async () => await wf.runAgent({ name: "classifier", prompt: "Classify this as research, verification, migration, triage, or creative. Return the label and rationale.\\n" + request, readOnly: true, modelHint: "fast" }));
  if (!classification) return "classification failed";
  const result = await wf.phase("act", async () => await wf.runAgent({ name: "routed-worker", prompt: "Act on this request according to the classification.\\nClassification: " + classification.finalText + "\\nRequest: " + request, readOnly: true, modelHint: "balanced", evidenceRefs: ["task_id:" + classification.taskId] }));
  return await wf.phase("synthesize", async () => await wf.synthesize({ inputs: [classification.finalText, result?.finalText ?? "worker failed"], rubric: "Explain the route and provide the completed result." }));
}`),
    module('fan-out-and-synthesize', 'Fan independent perspectives out, then merge them.', ['fan-out', 'synthesize'], 6, ['fan-out-and-synthesize'], `async function run(wf, args) {
  const request = String(args?.request ?? args?.question ?? "Analyze the task.");
  const angles = Array.isArray(args?.angles) ? args.angles : ["scope", "evidence", "risk", "recommendation"];
  const reports = await wf.phase("fan-out", async () => await wf.parallel(angles.map((angle, index) => async () => await wf.runAgent({ name: "angle-" + (index + 1), prompt: "Analyze from this angle: " + String(angle) + "\\n" + request, readOnly: true, modelHint: angle === "risk" ? "deep" : "balanced" })), { concurrency: 4 }));
  return await wf.phase("synthesize", async () => await wf.synthesize({ inputs: reports.filter(Boolean).map((item) => item.finalText), rubric: "Merge, deduplicate, and state a supported recommendation." }));
}`),
    module('adversarial-verification', 'Produce a candidate and attack it with an independent verifier.', ['candidate', 'verify', 'synthesize'], 3, ['adversarial-verification'], `async function run(wf, args) {
  const request = String(args?.request ?? "Solve and verify the task.");
  const candidate = await wf.phase("candidate", async () => await wf.runAgent({ name: "candidate", prompt: request, readOnly: true, modelHint: "deep" }));
  if (!candidate) return "candidate failed";
  const verifier = await wf.phase("verify", async () => await wf.runAgent({ name: "verifier", prompt: "Try to falsify this answer and retain only proven concerns.\\nRequest: " + request + "\\nCandidate: " + candidate.finalText, readOnly: true, modelHint: "deep", evidenceRefs: ["task_id:" + candidate.taskId] }));
  return await wf.phase("synthesize", async () => await wf.synthesize({ inputs: [candidate.finalText, verifier?.finalText ?? "verification failed"], rubric: "Return the corrected answer and verified caveats." }));
}`),
    module('generate-and-filter', 'Generate diverse candidates, then filter and rank them.', ['generate', 'filter', 'synthesize'], 7, ['generate-and-filter', 'fan-out-and-synthesize'], `async function run(wf, args) {
  const request = String(args?.request ?? "Generate good options.");
  const candidates = await wf.phase("generate", async () => await wf.parallel([1, 2, 3, 4].map((n) => async () => await wf.runAgent({ name: "generator-" + n, prompt: "Generate a distinct solution.\\n" + request, readOnly: true, modelHint: "balanced" })), { concurrency: 4 }));
  const filtered = await wf.phase("filter", async () => await wf.runAgent({ name: "filter", prompt: "Deduplicate, compare, and rank these candidates.\\n" + JSON.stringify(candidates), readOnly: true, modelHint: "deep" }));
  if (!filtered) return "filter step did not complete";
  return await wf.phase("synthesize", async () => await wf.synthesize({ inputs: [filtered.finalText], rubric: "Return only the strongest candidates with reasons." }));
}`),
    module('tournament', 'Run competing approaches and select a winner.', ['compete', 'judge'], 5, ['tournament'], `async function run(wf, args) {
  const request = String(args?.request ?? "Find the best solution.");
  const styles = ["conservative", "inventive", "risk-first"];
  const entries = await wf.phase("compete", async () => await wf.parallel(styles.map((style) => async () => await wf.runAgent({ name: "contestant-" + style, prompt: "Solve with a " + style + " strategy.\\n" + request, readOnly: true, modelHint: style === "risk-first" ? "deep" : "balanced" })), { concurrency: 3 }));
  return await wf.phase("judge", async () => await wf.synthesize({ inputs: entries.filter(Boolean).map((entry) => entry.finalText), rubric: "Compare pairwise, explain tradeoffs, and select or combine the strongest result." }));
}`),
    module('loop-until-done', 'Repeat bounded investigation rounds until evidence is exhausted.', ['iterate', 'synthesize'], 5, ['loop-until-done'], `async function run(wf, args) {
  const request = String(args?.request ?? "Investigate until complete.");
  const reports = [];
  await wf.phase("iterate", async () => {
    for (let round = 1; round <= 4; round += 1) {
      const report = await wf.runAgent({ name: "round-" + round, prompt: "Continue the investigation. Reply NO_NEW_FINDINGS when exhausted.\\n" + request + "\\nPrior: " + JSON.stringify(reports.map((item) => item.finalText)), readOnly: true, modelHint: "balanced" });
      if (!report) break;
      reports.push(report);
      if (/NO_NEW_FINDINGS/i.test(report.finalText)) break;
    }
  });
  return await wf.phase("synthesize", async () => await wf.synthesize({ inputs: reports.map((item) => item.finalText), rubric: "Deduplicate all findings and say whether the investigation converged." }));
}`),
];
export function listBuiltinWorkflows() {
    return [parallelInvestigation, scopedReviewWorkflow];
}
export function listWorkflowPatterns() {
    return patterns;
}
