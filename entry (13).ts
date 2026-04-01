import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { document_id } = await req.json();
    
    if (!document_id) {
      return Response.json({ error: 'document_id required' }, { status: 400 });
    }

    // Get the document
    const documents = await base44.entities.Document.filter({ id: document_id });
    const document = documents[0];
    
    if (!document) {
      return Response.json({ error: 'Document not found' }, { status: 404 });
    }

    // Analyze document using AI
    const analysisPrompt = `
You are a food safety compliance expert analyzing a document for ISO 22000 and TS 22002-4 compliance.

Document Type: ${document.document_type}
File Name: ${document.file_name}

Analyze this document thoroughly and extract:

1. **Expiry Date**: Any expiration or validity date (format: YYYY-MM-DD, null if none)
2. **Issuing Organization**: Who issued this document
3. **Certificate Number**: Any reference or certificate number
4. **Scope/Coverage**: What does this document cover
5. **Critical Parameters**: Any specifications, limits, or requirements mentioned
6. **Regulations Mentioned**: List all regulatory standards, laws, or frameworks referenced (e.g. ISO 22000, HACCP, EU 852/2004)
7. **Required Actions**: List specific actions the recipient/holder must take or comply with
8. **Compliance Status**: Is this document compliant, non-compliant, or requires review?
9. **Issues Found**: List any issues, gaps, or concerns (with severity: critical/high/medium/low)
10. **Suggested Tags**: Generate 3-8 short descriptive tags for categorising and searching this document (e.g. "HACCP", "allergens", "temperature control", "supplier approval")
11. **Summary**: A concise 2-3 sentence summary of what this document is and its compliance significance
12. **Confidence Score**: Your confidence in this analysis (0-100)

Be specific and actionable.
`;

    const analysis = await base44.integrations.Core.InvokeLLM({
      prompt: analysisPrompt,
      file_urls: [document.file_url],
      response_json_schema: {
        type: "object",
        properties: {
          expiry_date: { type: "string" },
          issuing_organization: { type: "string" },
          certificate_number: { type: "string" },
          scope: { type: "string" },
          critical_parameters: { 
            type: "array",
            items: {
              type: "object",
              properties: {
                parameter: { type: "string" },
                value: { type: "string" },
                unit: { type: "string" }
              }
            }
          },
          regulations_mentioned: {
            type: "array",
            items: { type: "string" }
          },
          required_actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string" },
                priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
                deadline_hint: { type: "string" }
              }
            }
          },
          suggested_tags: {
            type: "array",
            items: { type: "string" }
          },
          compliance_status: { 
            type: "string",
            enum: ["compliant", "non_compliant", "requires_review", "insufficient_data"]
          },
          issues_found: {
            type: "array",
            items: {
              type: "object",
              properties: {
                severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                issue: { type: "string" },
                recommendation: { type: "string" }
              }
            }
          },
          summary: { type: "string" },
          confidence_score: { type: "number" }
        }
      }
    });

    // Update document with analysis
    const ai_analysis = {
      analyzed: true,
      analyzed_date: new Date().toISOString(),
      extracted_data: {
        issuing_organization: analysis.issuing_organization,
        certificate_number: analysis.certificate_number,
        scope: analysis.scope,
        critical_parameters: analysis.critical_parameters || [],
        regulations_mentioned: analysis.regulations_mentioned || [],
        required_actions: analysis.required_actions || []
      },
      compliance_status: analysis.compliance_status || "requires_review",
      issues_found: analysis.issues_found || [],
      confidence_score: analysis.confidence_score || 0,
      summary: analysis.summary
    };

    // Merge AI-suggested tags with existing tags
    const existingTags = document.tags || [];
    const suggestedTags = analysis.suggested_tags || [];
    const mergedTags = [...new Set([...existingTags, ...suggestedTags])];

    // Update document with analysis and extracted expiry date
    const updateData = { ai_analysis, tags: mergedTags };
    if (analysis.expiry_date) {
      updateData.expiry_date = analysis.expiry_date;
    }

    await base44.asServiceRole.entities.Document.update(document_id, updateData);

    // Create action items for critical/high severity issues
    const criticalIssues = (analysis.issues_found || []).filter(
      issue => issue.severity === 'critical' || issue.severity === 'high'
    );

    for (const issue of criticalIssues) {
      await base44.asServiceRole.entities.ActionItem.create({
        title: `Document Issue: ${document.file_name}`,
        description: `${issue.issue}\n\nRecommendation: ${issue.recommendation}`,
        source_type: 'manual',
        source_id: document_id,
        priority: issue.severity === 'critical' ? 'critical' : 'high',
        status: 'pending',
        assigned_to: document.uploaded_by
      });
    }

    // Log activity
    await base44.asServiceRole.functions.invoke('logActivity', {
      activity_type: 'review_completed',
      entity_type: 'Document',
      entity_id: document_id,
      description: `AI analyzed document: ${analysis.compliance_status}`,
      metadata: {
        issues_count: analysis.issues_found?.length || 0,
        compliance_status: analysis.compliance_status
      },
      user_email: user.email
    });

    return Response.json({
      success: true,
      analysis: ai_analysis,
      action_items_created: criticalIssues.length
    });

  } catch (error) {
    console.error('Document analysis error:', error);
    return Response.json({ 
      error: 'Analysis failed', 
      details: error.message 
    }, { status: 500 });
  }
});