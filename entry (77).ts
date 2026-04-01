import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch compliance data to identify gaps
    const requirements = await base44.asServiceRole.entities.ComplianceRequirement.list("-updated_date", 200);
    const risks = await base44.asServiceRole.entities.RiskAssessment.list("-created_date", 100);
    const audits = await base44.asServiceRole.entities.ComplianceAudit.list("-audit_date", 5);

    // Identify gaps and training needs
    const nonCompliant = requirements.filter(r => 
      r.status === 'non_compliant' || r.status === 'not_started'
    ).slice(0, 10);

    const criticalRisks = risks.filter(r => 
      r.risk_level === 'critical' || r.risk_level === 'high'
    ).slice(0, 10);

    const auditFindings = audits.length > 0 && audits[0].findings 
      ? audits[0].findings.filter(f => f.severity === 'critical' || f.severity === 'high').slice(0, 5)
      : [];

    // Build comprehensive context
    const context = {
      gaps: nonCompliant.map(r => ({
        clause: r.clause_number,
        title: r.clause_title,
        section: r.section,
        priority: r.priority,
        findings: r.findings
      })),
      risks: criticalRisks.map(r => ({
        hazard_type: r.hazard_type,
        description: r.hazard_description,
        risk_level: r.risk_level,
        mitigation: r.mitigation_strategy
      })),
      auditFindings: auditFindings.map(f => ({
        issue: f.issue_type,
        severity: f.severity,
        description: f.description,
        recommendation: f.recommendation
      }))
    };

    const prompt = `As a compliance training expert for food safety and package manufacturing (ISO 22000:2018 & TS 22002-4), create a comprehensive, personalized training module based on these identified gaps:

COMPLIANCE GAPS (${nonCompliant.length}):
${JSON.stringify(context.gaps, null, 2)}

CRITICAL RISKS (${criticalRisks.length}):
${JSON.stringify(context.risks, null, 2)}

RECENT AUDIT FINDINGS (${auditFindings.length}):
${JSON.stringify(context.auditFindings, null, 2)}

Generate a training module that includes:

1. TITLE: Clear, specific training module title
2. DESCRIPTION: Brief overview (2-3 sentences)
3. CONTENT: Comprehensive training content in markdown format covering:
   - Key concepts and requirements
   - Best practices and procedures
   - Common pitfalls to avoid
   - Real-world examples
   - Step-by-step guidance
4. CATEGORY: One of: hazard_control, documentation, process_improvement, risk_management, quality_assurance, regulatory_compliance
5. DIFFICULTY: beginner, intermediate, or advanced
6. ESTIMATED_MINUTES: Realistic time estimate
7. QUIZ: 5 multiple-choice questions with 4 options each, correct answer index (0-3), and explanations

Make the training practical, actionable, and directly relevant to the identified gaps.`;

    const result = await base44.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          content: { type: "string" },
          category: {
            type: "string",
            enum: ["hazard_control", "documentation", "process_improvement", "risk_management", "quality_assurance", "regulatory_compliance"]
          },
          difficulty: {
            type: "string",
            enum: ["beginner", "intermediate", "advanced"]
          },
          estimated_minutes: { type: "number" },
          quiz_questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                options: {
                  type: "array",
                  items: { type: "string" }
                },
                correct_answer: { type: "number" },
                explanation: { type: "string" }
              }
            }
          }
        }
      }
    });

    // Create training module
    const module = await base44.entities.TrainingModule.create({
      title: result.title,
      description: result.description,
      content: result.content,
      category: result.category,
      difficulty: result.difficulty,
      estimated_minutes: result.estimated_minutes,
      quiz_questions: result.quiz_questions,
      related_requirements: nonCompliant.map(r => r.id),
      related_risks: criticalRisks.map(r => r.id),
      is_published: true,
      target_roles: ["user", "admin"]
    });

    return Response.json({
      success: true,
      module: module
    });

  } catch (error) {
    console.error('Error generating training module:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});