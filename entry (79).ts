import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { hazard_type, hazard_description, likelihood, severity, requirement_id } = await req.json();

    if (!hazard_type || !hazard_description) {
      return Response.json({ error: 'Hazard type and description required' }, { status: 400 });
    }

    const [allRisks, requirements] = await Promise.all([
      base44.asServiceRole.entities.RiskAssessment.list("-created_date", 200),
      base44.asServiceRole.entities.ComplianceRequirement.list("-created_date", 200)
    ]);

    const similarRisks = allRisks.filter(r => r.hazard_type === hazard_type);

    const successfulMitigations = similarRisks
      .filter(r => r.mitigation_strategy && r.residual_risk && 
        ['low', 'medium'].includes(r.residual_risk))
      .slice(0, 5)
      .map(r => ({
        description: r.hazard_description?.substring(0, 100),
        strategy: r.mitigation_strategy?.substring(0, 200)
      }));

    const complianceGaps = requirements
      .filter(r => ['non_compliant', 'not_started'].includes(r.status))
      .slice(0, 5)
      .map(r => `${r.clause_number}: ${r.clause_title} (${r.status})`)
      .join('\n');

    let relatedRequirement = null;
    if (requirement_id) {
      relatedRequirement = requirements.find(r => r.id === requirement_id);
    }

    const prompt = `As a packaging safety expert specializing in ISO 22000 compliance, provide risk mitigation recommendations.

CURRENT RISK:
- Type: ${hazard_type}
- Description: ${hazard_description}
- Likelihood: ${likelihood || 'unknown'}
- Severity: ${severity || 'unknown'}
${relatedRequirement ? `- Related to: ${relatedRequirement.clause_number} ${relatedRequirement.clause_title}` : ''}

SUCCESSFUL PAST MITIGATIONS FOR SIMILAR ${hazard_type.toUpperCase()} RISKS:
${successfulMitigations.length > 0 ? successfulMitigations.map((m, i) => `${i + 1}. ${m.description}\nStrategy: ${m.strategy}`).join('\n\n') : 'No historical data available for this hazard type.'}

CURRENT COMPLIANCE GAPS TO ADDRESS:
${complianceGaps || 'No major compliance gaps identified.'}

Based on historical successes, compliance gaps, and industry best practices, provide:
1. Immediate control measures (prioritize quick wins)
2. Long-term mitigation strategies (addressing root causes)
3. Monitoring and verification methods
4. Expected residual risk level after implementation
5. Industry best practices specific to packaging manufacturing
6. Relevant ISO 22000/TS 22002-4 clauses to address
7. How these measures also help close related compliance gaps`;

    const result = await base44.integrations.Core.InvokeLLM({
      prompt,
      add_context_from_internet: true,
      response_json_schema: {
        type: "object",
        properties: {
          immediate_controls: {
            type: "array",
            items: { type: "string" }
          },
          long_term_strategies: {
            type: "array",
            items: { type: "string" }
          },
          monitoring_methods: {
            type: "array",
            items: { type: "string" }
          },
          expected_residual_risk: { type: "string" },
          best_practices: {
            type: "array",
            items: { type: "string" }
          },
          iso_clauses: {
            type: "array",
            items: { type: "string" }
          },
          compliance_gap_benefits: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    });

    return Response.json({
      success: true,
      recommendations: result,
      similar_cases_analyzed: similarRisks.length,
      compliance_gaps_identified: complianceGaps ? complianceGaps.split('\n').length : 0
    });
  } catch (error) {
    console.error('Error getting recommendations:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});