import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch comprehensive compliance data
    const [requirements, risks, audits, actions] = await Promise.all([
      base44.asServiceRole.entities.ComplianceRequirement.list("-updated_date", 200),
      base44.asServiceRole.entities.RiskAssessment.list("-created_date", 100),
      base44.asServiceRole.entities.ComplianceAudit.list("-audit_date", 10),
      base44.asServiceRole.entities.ActionItem.list("-created_date", 100)
    ]);

    // Analyze current state
    const nonCompliantCount = requirements.filter(r => 
      r.status === 'non_compliant' || r.status === 'not_started'
    ).length;

    const criticalRisks = risks.filter(r => 
      r.risk_level === 'critical' || r.risk_level === 'high'
    );

    const overdueRequirements = requirements.filter(r => 
      r.due_date && new Date(r.due_date) < new Date() && r.status !== 'compliant'
    );

    const lastAuditDate = audits.length > 0 ? audits[0].audit_date : null;
    const daysSinceLastAudit = lastAuditDate 
      ? Math.floor((new Date() - new Date(lastAuditDate)) / (1000 * 60 * 60 * 24))
      : 365;

    // Group requirements by section
    const sectionGaps = {};
    requirements.filter(r => r.status !== 'compliant').forEach(r => {
      if (!sectionGaps[r.section]) {
        sectionGaps[r.section] = 0;
      }
      sectionGaps[r.section]++;
    });

    const prompt = `As an ISO 22000:2018 compliance auditing expert for package manufacturing, analyze the current compliance state and generate a comprehensive audit plan with 2-3 recommended audits.

CURRENT COMPLIANCE STATUS:
- Total Requirements: ${requirements.length}
- Non-Compliant/Not Started: ${nonCompliantCount}
- Critical/High Risks: ${criticalRisks.length}
- Overdue Requirements: ${overdueRequirements.length}
- Days Since Last Audit: ${daysSinceLastAudit}

SECTION GAPS:
${Object.entries(sectionGaps).map(([section, count]) => `- ${section}: ${count} gaps`).join('\n')}

TOP CRITICAL RISKS:
${criticalRisks.slice(0, 5).map(r => `- ${r.hazard_type}: ${r.hazard_description} (${r.risk_level})`).join('\n')}

TOP OVERDUE REQUIREMENTS:
${overdueRequirements.slice(0, 5).map(r => `- ${r.clause_number}: ${r.clause_title} (Due: ${r.due_date})`).join('\n')}

RECENT AUDIT FINDINGS:
${audits.length > 0 && audits[0].findings ? audits[0].findings.slice(0, 3).map(f => `- ${f.issue_type}: ${f.description}`).join('\n') : 'No recent audit data'}

Generate 2-3 strategic audit plans that:
1. Address the most critical compliance gaps
2. Cover high-risk areas
3. Follow a logical audit schedule
4. Include specific focus areas and objectives
5. Provide detailed rationale
6. Recommend auditor expertise needed
7. Include comprehensive checklist items

Consider:
- ISO 22000:2018 requirements
- Risk-based audit approach
- Regulatory compliance cycles
- Resource optimization`;

    const result = await base44.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: "object",
        properties: {
          audit_plans: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                audit_type: {
                  type: "string",
                  enum: ["internal", "external", "supplier", "management_review", "certification"]
                },
                suggested_date: { type: "string" },
                end_date: { type: "string" },
                priority: {
                  type: "string",
                  enum: ["low", "medium", "high", "critical"]
                },
                scope: { type: "string" },
                focus_areas: {
                  type: "array",
                  items: { type: "string" }
                },
                rationale: { type: "string" },
                recommended_auditors: {
                  type: "array",
                  items: { type: "string" }
                },
                estimated_duration_hours: { type: "number" },
                confidence_score: { type: "number" },
                checklist: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      item: { type: "string" },
                      category: { type: "string" },
                      completed: { type: "boolean" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    // Create audit plan records
    const createdPlans = [];
    for (const plan of result.audit_plans || []) {
      const created = await base44.entities.AuditPlan.create({
        title: plan.title,
        audit_type: plan.audit_type,
        suggested_date: plan.suggested_date,
        end_date: plan.end_date,
        priority: plan.priority,
        scope: plan.scope,
        focus_areas: plan.focus_areas,
        rationale: plan.rationale,
        recommended_auditors: plan.recommended_auditors,
        estimated_duration_hours: plan.estimated_duration_hours,
        confidence_score: plan.confidence_score,
        checklist: plan.checklist,
        status: "suggested",
        related_requirements: overdueRequirements.slice(0, 5).map(r => r.id),
        related_risks: criticalRisks.slice(0, 5).map(r => r.id)
      });
      createdPlans.push(created);
    }

    return Response.json({
      success: true,
      plans: createdPlans,
      analysis: {
        total_requirements: requirements.length,
        non_compliant_count: nonCompliantCount,
        critical_risks: criticalRisks.length,
        days_since_last_audit: daysSinceLastAudit
      }
    });

  } catch (error) {
    console.error('Error generating audit plan:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});