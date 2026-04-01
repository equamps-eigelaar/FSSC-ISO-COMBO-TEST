import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { file_url, file_name, doc_type } = await req.json();
    if (!file_url) return Response.json({ error: 'file_url required' }, { status: 400 });

    const prompt = `You are a document control expert specializing in ISO 22000, FSSC 22000 and GMP compliance for packaging manufacturers (CTP Flexibles).

Analyze the uploaded document (${doc_type || 'document'}: "${file_name || 'unknown'}") and evaluate it for compliance with document control requirements.

Assess the document against these FSSC 22000 / ISO document control criteria:
1. Document identification (title, doc number, revision number, date)
2. Scope and purpose clearly stated
3. Responsibilities defined
4. Review and approval signatures/authority
5. Effective date / review date
6. Revision history / change log
7. References to related documents
8. Content alignment with FSSC 22000 / TS 22002-4 requirements
9. Adequate detail for the document type (PRP/Plan/Policy/Procedure/WI/Form)
10. Distribution / controlled copy status

Return a thorough compliance evaluation with:
- overall_score: 0-100 compliance score
- overall_status: "compliant", "minor_gaps", "major_gaps", "non_compliant"
- doc_type_detected: detected document type
- strengths: what the document does well (array of strings)
- gaps: specific gaps found with reference to the criteria above (array of objects: {issue, criterion, severity: "minor"|"major"|"critical"})
- recommended_changes: concrete, actionable edits to make this document compliant (array of strings)
- missing_fields: fields that are completely missing and must be added (array of strings)
- summary: 3-4 sentence executive summary of the compliance evaluation
- suggested_revision: what the next revision number should be (e.g. "Rev 2", "Rev A")
`;

    const result = await base44.integrations.Core.InvokeLLM({
      prompt,
      file_urls: [file_url],
      response_json_schema: {
        type: "object",
        properties: {
          overall_score: { type: "number" },
          overall_status: { type: "string", enum: ["compliant", "minor_gaps", "major_gaps", "non_compliant"] },
          doc_type_detected: { type: "string" },
          strengths: { type: "array", items: { type: "string" } },
          gaps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                issue: { type: "string" },
                criterion: { type: "string" },
                severity: { type: "string", enum: ["minor", "major", "critical"] }
              }
            }
          },
          recommended_changes: { type: "array", items: { type: "string" } },
          missing_fields: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          suggested_revision: { type: "string" }
        }
      }
    });

    return Response.json({ success: true, ...result });

  } catch (error) {
    console.error('evaluateDocumentCompliance error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});