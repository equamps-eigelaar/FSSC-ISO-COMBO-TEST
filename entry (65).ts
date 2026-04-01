import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { report_type, stakeholder_type } = await req.json();
    
    // Fetch all compliance data
    const requirements = await base44.asServiceRole.entities.ComplianceRequirement.list("-created_date", 300);
    const risks = await base44.asServiceRole.entities.RiskAssessment.list("-created_date", 300);
    
    // Calculate statistics
    const total = requirements.length;
    const compliant = requirements.filter(r => r.status === "compliant").length;
    const inProgress = requirements.filter(r => r.status === "in_progress").length;
    const nonCompliant = requirements.filter(r => r.status === "non_compliant").length;
    const notStarted = requirements.filter(r => r.status === "not_started").length;
    
    // Group by section
    const sections = {};
    requirements.forEach(req => {
      if (!sections[req.section]) {
        sections[req.section] = { total: 0, compliant: 0 };
      }
      sections[req.section].total++;
      if (req.status === "compliant") sections[req.section].compliant++;
    });
    
    // Risk breakdown
    const criticalRisks = risks.filter(r => r.risk_level === "critical").length;
    const highRisks = risks.filter(r => r.risk_level === "high").length;
    const actionRequired = risks.filter(r => r.status === "requires_action").length;
    
    // Overdue items
    const today = new Date();
    const overdue = requirements.filter(r => 
      r.due_date && new Date(r.due_date) < today && r.status !== "compliant"
    ).length;
    
    // Create prompt based on stakeholder type
    let prompt = "";
    
    if (stakeholder_type === "executive") {
      prompt = `You are a compliance reporting AI. Generate an executive summary report for a package manufacturing compliance system (ISO 22000:2018 & TS 22002-4).

Data:
- Total Requirements: ${total}
- Compliant: ${compliant} (${Math.round(compliant/total*100)}%)
- In Progress: ${inProgress}
- Non-Compliant: ${nonCompliant}
- Not Started: ${notStarted}
- Critical Risks: ${criticalRisks}
- High Risks: ${highRisks}
- Overdue Items: ${overdue}

Section Performance:
${Object.entries(sections).map(([name, data]) => 
  `- ${name}: ${data.compliant}/${data.total} (${Math.round(data.compliant/data.total*100)}%)`
).join('\n')}

Generate a concise executive summary (300-400 words) covering:
1. Overall compliance status and key metrics
2. Top 3 areas of concern requiring immediate attention
3. Positive achievements and progress highlights
4. Strategic recommendations for leadership
5. Risk exposure summary

Use professional, executive-level language.`;
    } else if (stakeholder_type === "auditor") {
      prompt = `You are a compliance reporting AI. Generate a detailed audit report for a package manufacturing compliance system (ISO 22000:2018 & TS 22002-4).

Data:
- Total Requirements: ${total}
- Compliant: ${compliant} (${Math.round(compliant/total*100)}%)
- In Progress: ${inProgress}
- Non-Compliant: ${nonCompliant}
- Not Started: ${notStarted}
- Critical Risks: ${criticalRisks}
- High Risks: ${highRisks}
- Risks Requiring Action: ${actionRequired}
- Overdue Items: ${overdue}

Section Compliance:
${Object.entries(sections).map(([name, data]) => 
  `- ${name}: ${data.compliant}/${data.total} compliant (${Math.round(data.compliant/data.total*100)}%)`
).join('\n')}

Generate a comprehensive audit report (500-600 words) including:
1. Compliance status by ISO 22000 clause and TS 22002-4 section
2. Gap analysis - identify non-compliant and not started items
3. Risk assessment summary with critical findings
4. Evidence adequacy assessment
5. Specific corrective action recommendations
6. Timeline for achieving full compliance

Use formal audit terminology and be specific.`;
    } else {
      // team_lead or default
      prompt = `You are a compliance reporting AI. Generate an operational report for compliance team leads in a package manufacturing facility (ISO 22000:2018 & TS 22002-4).

Data:
- Total Requirements: ${total}
- Compliant: ${compliant} (${Math.round(compliant/total*100)}%)
- In Progress: ${inProgress}
- Non-Compliant: ${nonCompliant}
- Not Started: ${notStarted}
- Critical Risks: ${criticalRisks}
- High Risks: ${highRisks}
- Items Requiring Action: ${actionRequired}
- Overdue Items: ${overdue}

Section Status:
${Object.entries(sections).map(([name, data]) => 
  `- ${name}: ${data.compliant}/${data.total} (${Math.round(data.compliant/data.total*100)}%)`
).join('\n')}

Generate an actionable operational report (400-500 words) covering:
1. Current compliance progress summary
2. Priority action items for the team
3. Sections requiring immediate focus (lowest compliance scores)
4. Risk mitigation tasks that need assignment
5. Suggested next steps and quick wins
6. Resource allocation recommendations

Use practical, action-oriented language for operational teams.`;
    }
    
    // Get AI insights
    const aiResponse = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: prompt,
      add_context_from_internet: false
    });
    
    // Generate focus areas
    const lowestScoringSections = Object.entries(sections)
      .map(([name, data]) => ({
        name,
        score: data.total > 0 ? Math.round(data.compliant/data.total*100) : 0,
        compliant: data.compliant,
        total: data.total
      }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 5);
    
    return Response.json({
      success: true,
      report: {
        generated_date: new Date().toISOString(),
        stakeholder_type,
        summary: aiResponse,
        metrics: {
          total,
          compliant,
          in_progress: inProgress,
          non_compliant: nonCompliant,
          not_started: notStarted,
          compliance_percentage: Math.round(compliant/total*100)
        },
        risk_summary: {
          critical: criticalRisks,
          high: highRisks,
          requires_action: actionRequired
        },
        focus_areas: lowestScoringSections,
        overdue_count: overdue
      }
    });
  } catch (error) {
    console.error('Error generating AI report:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});