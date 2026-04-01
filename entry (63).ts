import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const requirements = await base44.asServiceRole.entities.ComplianceRequirement.list("-created_date", 200);
    const risks = await base44.asServiceRole.entities.RiskAssessment.list("-created_date", 200);
    const activities = await base44.asServiceRole.entities.ActivityLog.list("-created_date", 100);

    const complianceStats = {
      total: requirements.length,
      compliant: requirements.filter(r => r.status === 'compliant').length,
      in_progress: requirements.filter(r => r.status === 'in_progress').length,
      non_compliant: requirements.filter(r => r.status === 'non_compliant').length,
      not_started: requirements.filter(r => r.status === 'not_started').length
    };

    const riskStats = {
      total: risks.length,
      critical: risks.filter(r => r.risk_level === 'critical').length,
      high: risks.filter(r => r.risk_level === 'high').length,
      medium: risks.filter(r => r.risk_level === 'medium').length,
      low: risks.filter(r => r.risk_level === 'low').length
    };

    const prompt = `As a compliance reporting expert, generate a comprehensive compliance report based on this data:

COMPLIANCE REQUIREMENTS:
- Total: ${complianceStats.total}
- Compliant: ${complianceStats.compliant}
- In Progress: ${complianceStats.in_progress}
- Non-Compliant: ${complianceStats.non_compliant}
- Not Started: ${complianceStats.not_started}

RISK ASSESSMENTS:
- Total: ${riskStats.total}
- Critical: ${riskStats.critical}
- High: ${riskStats.high}
- Medium: ${riskStats.medium}
- Low: ${riskStats.low}

TOP REQUIREMENTS NEEDING ATTENTION:
${requirements.filter(r => r.status === 'non_compliant' || r.status === 'not_started').slice(0, 5).map(r => 
  `- ${r.clause_number}: ${r.clause_title} (Status: ${r.status})`
).join('\n')}

CRITICAL RISKS:
${risks.filter(r => r.risk_level === 'critical' || r.risk_level === 'high').slice(0, 5).map(r => 
  `- ${r.hazard_type}: ${r.hazard_description?.substring(0, 100)}`
).join('\n')}

Generate a professional compliance report with:
1. Executive Summary
2. Overall Compliance Status
3. Key Findings
4. Critical Issues & Recommendations
5. Risk Assessment Summary
6. Action Plan & Next Steps`;

    const result = await base44.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: "object",
        properties: {
          executive_summary: { type: "string" },
          compliance_status: { type: "string" },
          key_findings: {
            type: "array",
            items: { type: "string" }
          },
          critical_issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                issue: { type: "string" },
                impact: { type: "string" },
                recommendation: { type: "string" },
                priority: { type: "string" }
              }
            }
          },
          risk_summary: { type: "string" },
          action_plan: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string" },
                owner: { type: "string" },
                timeline: { type: "string" }
              }
            }
          }
        }
      }
    });

    return Response.json({
      success: true,
      report: result,
      stats: { compliance: complianceStats, risks: riskStats }
    });
  } catch (error) {
    console.error('Error generating report:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});