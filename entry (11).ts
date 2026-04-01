import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { requirementId, findings, clause_number, clause_title, section, description } = await req.json();

  if (!findings || !clause_number) {
    return Response.json({ error: 'findings and clause_number are required' }, { status: 400 });
  }

  // Gather historical context in parallel
  const [allRequirements, allActionItems, allRiskAssessments] = await Promise.all([
    base44.asServiceRole.entities.ComplianceRequirement.list('-created_date', 300),
    base44.asServiceRole.entities.ActionItem.list('-created_date', 200),
    base44.asServiceRole.entities.RiskAssessment.list('-created_date', 200),
  ]);

  // Historical requirements for same or related clauses
  const historicalReqs = allRequirements.filter(r =>
    r.id !== requirementId &&
    (r.clause_number === clause_number ||
      r.clause_number?.startsWith(clause_number.split('.')[0]) ||
      r.section === section)
  ).slice(0, 15);

  // Past action items related to this clause
  const relatedActions = allActionItems.filter(a =>
    a.clause_reference === clause_number ||
    a.related_requirement_id === requirementId ||
    (a.title?.toLowerCase().includes(clause_number) || a.description?.toLowerCase().includes(clause_title?.toLowerCase()))
  ).slice(0, 10);

  // Risk assessments for this requirement
  const relatedRisks = allRiskAssessments.filter(r =>
    r.requirement_id === requirementId
  ).slice(0, 10);

  // Existing controls (compliant requirements in same section)
  const existingControls = historicalReqs.filter(r =>
    r.status === 'compliant' && r.corrective_actions
  ).slice(0, 5);

  // Build context summary for the LLM
  const historicalFindingsSummary = historicalReqs
    .filter(r => r.findings)
    .map(r => `Clause ${r.clause_number} (${r.status}): ${r.findings}${r.corrective_actions ? ` → Actions taken: ${r.corrective_actions}` : ''}`)
    .join('\n');

  const pastActionsSummary = relatedActions
    .map(a => `[${a.status}] ${a.title}: ${a.description || ''}`)
    .join('\n');

  const riskSummary = relatedRisks
    .map(r => `Risk "${r.hazard_description || r.hazard_category}" – Level: ${r.risk_level}, Mitigation: ${r.mitigation_strategy || 'None'}`)
    .join('\n');

  const controlsSummary = existingControls
    .map(r => `Clause ${r.clause_number}: ${r.corrective_actions}`)
    .join('\n');

  const prompt = `You are an ISO 22000 / FSSC 22000 compliance expert performing an audit findings analysis for a food packaging manufacturing facility.

CURRENT REQUIREMENT:
- Clause: ${clause_number} – ${clause_title}
- Section: ${section}
- Description: ${description || 'N/A'}
- Current Audit Findings / Gaps: ${findings}

HISTORICAL FINDINGS FOR RELATED CLAUSES:
${historicalFindingsSummary || 'No historical findings available.'}

EXISTING CORRECTIVE ACTIONS THAT WORKED (from compliant requirements):
${controlsSummary || 'No existing controls data available.'}

PAST ACTION ITEMS FOR THIS CLAUSE:
${pastActionsSummary || 'No past action items.'}

RISK ASSESSMENTS LINKED TO THIS REQUIREMENT:
${riskSummary || 'No risk assessments linked.'}

Based on this comprehensive context, provide a structured analysis with:
1. Pattern recognition – has this finding occurred before and what was the outcome?
2. Root cause analysis – most likely root causes based on history
3. Specific corrective actions – ranked by effectiveness, referencing what worked before
4. Preventive measures – to stop recurrence based on historical patterns
5. Quick wins – actions that can be implemented immediately

Return a JSON object with this exact structure:
{
  "pattern_analysis": "string describing historical patterns found",
  "root_causes": ["root cause 1", "root cause 2", "root cause 3"],
  "corrective_actions": [
    {
      "title": "short action title",
      "description": "detailed description of what to do",
      "priority": "critical|high|medium|low",
      "timeline": "e.g. 2 weeks",
      "effectiveness": "high|medium|low",
      "based_on_history": true or false,
      "historical_context": "brief note on what worked historically or null"
    }
  ],
  "preventive_measures": ["measure 1", "measure 2"],
  "quick_wins": ["quick win 1", "quick win 2"],
  "overall_recommendation": "1-2 sentence strategic recommendation"
}`;

  const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
    prompt,
    response_json_schema: {
      type: "object",
      properties: {
        pattern_analysis: { type: "string" },
        root_causes: { type: "array", items: { type: "string" } },
        corrective_actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              priority: { type: "string" },
              timeline: { type: "string" },
              effectiveness: { type: "string" },
              based_on_history: { type: "boolean" },
              historical_context: { type: "string" }
            }
          }
        },
        preventive_measures: { type: "array", items: { type: "string" } },
        quick_wins: { type: "array", items: { type: "string" } },
        overall_recommendation: { type: "string" }
      }
    }
  });

  return Response.json({
    ...result,
    historical_records_analyzed: historicalReqs.length,
    past_actions_analyzed: relatedActions.length,
    risks_analyzed: relatedRisks.length,
  });
});