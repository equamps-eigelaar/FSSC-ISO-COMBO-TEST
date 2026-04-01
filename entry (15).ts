import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { assessment_id } = await req.json();
    if (!assessment_id) return Response.json({ error: 'assessment_id required' }, { status: 400 });

    const assessments = await base44.entities.SupplierSelfAssessment.filter({ id: assessment_id });
    const assessment = assessments[0];
    if (!assessment) return Response.json({ error: 'Assessment not found' }, { status: 404 });

    // Fetch current compliance requirements for context
    const requirements = await base44.asServiceRole.entities.ComplianceRequirement.list('-updated_date', 200);
    const complianceContext = requirements.map(r =>
      `Clause ${r.clause_number} (${r.clause_title}): Status=${r.status}, Completion=${r.completion_percentage || 0}%, Priority=${r.priority || 'medium'}`
    ).join('\n');

    const prompt = `You are a food safety and packaging compliance expert for CTP Flexibles, a FSSC 22000 certified primary packaging manufacturer serving food, beverage, pharmaceutical and retail sectors.

TASK: Analyze the uploaded supplier/customer questionnaire document and produce a detailed compliance self-assessment.

CTP FLEXIBLES COMPLIANCE SNAPSHOT:
${complianceContext}

COMPANY PROFILE:
- FSSC 22000 certified packaging manufacturer
- Implements food defence, food fraud prevention, allergen control
- Primary & secondary packaging for food, beverage, pharma, retail
- Full QMS with documented procedures, corrective action processes

INSTRUCTIONS:
1. Read every section and question in the uploaded questionnaire carefully.
2. For each question, pre-fill an answer based on CTP Flexibles' FSSC 22000 status and compliance snapshot above.
3. Flag questions that need human review (where evidence is uncertain or partial).
4. Extract all identified risks and required corrective actions.
5. Calculate section-level compliance scores.

ANSWER KEY:
- "yes" = fully compliant, documented evidence likely exists
- "partial" = partially compliant, some gaps or missing documentation
- "no" = non-compliant, significant gap exists
- "na" = not applicable to a packaging manufacturer

SCORING: yes=100pts, partial=50pts, no=0pts, na=excluded from average.

OUTPUT REQUIREMENTS:
- sections: detailed sections from the document with all questions answered
- identified_risks: list of specific risks found in the questionnaire or gaps in compliance
- required_actions: concrete actions CTP Flexibles must take to close gaps
- flagged_for_review: questions/areas where human review is critical
- compliance_status_by_section: section-level compliance summary
- risk_score: overall 0-100 compliance %
- risk_rating: "low" (>80), "medium" (60-80), "high" (40-60), "critical" (<40)
- ai_summary: 4-5 sentence executive summary covering compliance status, key risks, and next steps
- ai_gaps: top 6 specific compliance gaps identified
- ai_recommendations: top 6 actionable recommendations with priority context
`;

    const result = await base44.integrations.Core.InvokeLLM({
      prompt,
      file_urls: [assessment.questionnaire_file_url],
      response_json_schema: {
        type: "object",
        properties: {
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                section_title: { type: "string" },
                questions: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      question: { type: "string" },
                      requirement: { type: "string" },
                      ai_answer: { type: "string", enum: ["yes", "no", "partial", "na"] },
                      comments: { type: "string" },
                      needs_review: { type: "boolean" },
                      risk_flag: { type: "string" },
                      weight: { type: "number" }
                    }
                  }
                }
              }
            }
          },
          identified_risks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                risk: { type: "string" },
                severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
                area: { type: "string" }
              }
            }
          },
          required_actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string" },
                priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
                area: { type: "string" }
              }
            }
          },
          flagged_for_review: {
            type: "array",
            items: { type: "string" }
          },
          compliance_status_by_section: {
            type: "array",
            items: {
              type: "object",
              properties: {
                section: { type: "string" },
                score: { type: "number" },
                status: { type: "string", enum: ["compliant", "partial", "non_compliant"] }
              }
            }
          },
          risk_score: { type: "number" },
          risk_rating: { type: "string", enum: ["low", "medium", "high", "critical"] },
          ai_summary: { type: "string" },
          ai_gaps: { type: "array", items: { type: "string" } },
          ai_recommendations: { type: "array", items: { type: "string" } }
        }
      }
    });

    // Populate user_answer from ai_answer initially
    const sections = (result.sections || []).map(section => ({
      ...section,
      questions: (section.questions || []).map(q => ({
        ...q,
        user_answer: q.ai_answer,
        evidence_notes: ''
      }))
    }));

    const updatePayload = {
      sections,
      risk_score: result.risk_score,
      risk_rating: result.risk_rating,
      ai_summary: result.ai_summary,
      ai_gaps: result.ai_gaps || [],
      ai_recommendations: result.ai_recommendations || [],
      identified_risks: result.identified_risks || [],
      required_actions: result.required_actions || [],
      flagged_for_review: result.flagged_for_review || [],
      compliance_status_by_section: result.compliance_status_by_section || [],
      status: 'in_progress'
    };

    await base44.asServiceRole.entities.SupplierSelfAssessment.update(assessment_id, updatePayload);

    return Response.json({ success: true, ...updatePayload });

  } catch (error) {
    console.error('analyzeSupplierQuestionnaire error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});