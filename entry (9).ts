/**
 * aiEvidenceComplianceAnalyzer
 *
 * Background AI process that cross-references uploaded evidence documents
 * against each compliance requirement. For each requirement it:
 *   1. Finds all linked documents (via Document.linked_requirement_ids)
 *   2. Asks AI to assess whether the evidence is sufficient for the clause
 *   3. Updates the requirement's findings with AI verdict
 *   4. Creates specific ActionItems for any gaps (avoids duplicates)
 *   5. Sends in-app + email notifications to the assigned person
 *
 * Runs on a schedule. Processes max 25 requirements per run, prioritising
 * the worst-status ones. Skips requirements re-analyzed within 7 days.
 *
 * Uses claude_sonnet_4_6 for high-quality compliance reasoning.
 * NOTE: This uses more integration credits due to the advanced AI model.
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const MAX_PROMPT_DOCS = 5; // Cap docs sent to AI per requirement

const MAX_PER_RUN = 1;
const REANALYSIS_COOLDOWN_DAYS = 7;
// Priority order for processing
const STATUS_PRIORITY = {
  non_compliant: 0,
  partial: 1,
  in_progress: 2,
  not_started: 3,
};

function daysSince(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

// Deduplication: check if the requirement's findings already contain a recent AI review block
function wasRecentlyAnalyzedFromFindings(req) {
  if (!req.findings) return false;
  const match = req.findings.match(/\[AI Evidence Review — (\d{2}\/\d{2}\/\d{4})\]/);
  if (!match) return false;
  // Parse SA locale date dd/mm/yyyy
  const [day, month, year] = match[1].split('/');
  const reviewDate = new Date(`${year}-${month}-${day}`);
  return daysSince(reviewDate.toISOString()) < REANALYSIS_COOLDOWN_DAYS;
}

function actionItemAlreadyExists(existingActionItems, requirementId, actionDescription) {
  return existingActionItems.some(a =>
    a.source_id === requirementId &&
    a.status !== 'completed' &&
    a.title?.toLowerCase().includes(actionDescription.toLowerCase().slice(0, 30))
  );
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const today = new Date().toISOString();

    // ── Load all data in parallel ──────────────────────────────────────
    const [allRequirements, allDocuments, recentActionItems] = await Promise.all([
      base44.asServiceRole.entities.ComplianceRequirement.list('-updated_date', 30),
      base44.asServiceRole.entities.Document.list('-created_date', 60),
      base44.asServiceRole.entities.ActionItem.filter({ source_type: 'compliance_audit' }, '-created_date', 30),
    ]);

    // Filter out already-compliant requirements
    const candidates = allRequirements.filter(r => r.status !== 'compliant');

    // Sort by worst status first
    candidates.sort((a, b) =>
      (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99)
    );

    // Build a lookup: requirementId → linked documents
    const docsByRequirement = {};
    for (const doc of allDocuments) {
      for (const reqId of (doc.linked_requirement_ids || [])) {
        if (!docsByRequirement[reqId]) docsByRequirement[reqId] = [];
        docsByRequirement[reqId].push(doc);
      }
    }

    const results = [];
    let processed = 0;
    let skipped = 0;
    let actionsCreated = 0;

    for (const req of candidates) {
      if (processed >= MAX_PER_RUN) break;

      // Skip if recently analyzed (check findings timestamp)
      if (wasRecentlyAnalyzedFromFindings(req)) {
        skipped++;
        continue;
      }

      const linkedDocs = docsByRequirement[req.id] || [];

      // Build document summaries for the AI prompt (use existing AI analysis when available)
      const docSummaries = linkedDocs.slice(0, MAX_PROMPT_DOCS).map(doc => {
        const ai = doc.ai_analysis;
        return {
          file_name: doc.file_name,
          category: doc.category,
          title: doc.title || doc.file_name,
          expiry_date: doc.expiry_date || null,
          control_status: doc.control_status,
          ai_compliance_status: ai?.compliance_status || 'not_analyzed',
          ai_summary: ai?.summary || null,
          ai_issues: ai?.issues_found?.map(i => `[${i.severity}] ${i.issue}`)?.join('; ') || null,
          tags: (doc.tags || []).join(', '),
        };
      });

      // ── AI Evidence Assessment ─────────────────────────────────────
      const prompt = `
You are a senior ISO 22000 / FSSC 22000 compliance auditor with expertise in food and packaging manufacturing.

COMPLIANCE REQUIREMENT:
- Clause: ${req.clause_number} – ${req.clause_title}
- Section: ${req.section}
- Description: ${req.description || 'No description provided'}
- Current Status: ${req.status?.replace(/_/g, ' ')}
- Priority: ${req.priority}
- Evidence Notes (user-entered): ${req.evidence_notes || 'None'}
- Existing Findings: ${req.findings || 'None'}

LINKED EVIDENCE DOCUMENTS (${linkedDocs.length} documents found):
${docSummaries.length > 0
  ? docSummaries.map((d, i) => `
  Document ${i + 1}: "${d.title}"
    - Category: ${d.category}
    - Expiry: ${d.expiry_date || 'N/A'}
    - Control Status: ${d.control_status}
    - AI Compliance Status: ${d.ai_compliance_status}
    - AI Summary: ${d.ai_summary || 'Not yet analyzed'}
    - Known Issues: ${d.ai_issues || 'None identified'}
    - Tags: ${d.tags || 'None'}
`).join('')
  : '  NO DOCUMENTS LINKED — no evidence has been uploaded for this requirement.'}

TASK:
Assess whether the uploaded evidence is sufficient to demonstrate compliance with this specific clause.

Consider:
1. Does the volume and type of evidence match what this clause requires?
2. Are any required document types entirely missing?
3. Are any linked documents expired, non-compliant, or insufficient?
4. What specific corrective actions should the responsible person take?

Be precise, actionable, and reference the specific clause requirements in your analysis.
`;

      const assessment = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt,
        model: 'gpt_5_mini',
        response_json_schema: {
          type: 'object',
          properties: {
            verdict: {
              type: 'string',
              enum: ['compliant', 'partially_compliant', 'non_compliant', 'insufficient_evidence'],
            },
            has_sufficient_evidence: { type: 'boolean' },
            evidence_quality_score: { type: 'number' },
            summary: { type: 'string' },
            gaps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                  missing_document_type: { type: 'string' },
                },
              },
            },
            corrective_actions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string' },
                  priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                  rationale: { type: 'string' },
                },
              },
            },
          },
        },
      });

      // ── Update requirement findings ─────────────────────────────────
      const aiFindings = `[AI Evidence Review — ${new Date().toLocaleDateString('en-ZA')}]\n` +
        `Verdict: ${assessment.verdict?.replace(/_/g, ' ') || 'Unknown'} | ` +
        `Evidence Score: ${assessment.evidence_quality_score ?? 'N/A'}/100 | ` +
        `Documents Reviewed: ${linkedDocs.length}\n\n` +
        `${assessment.summary || ''}\n\n` +
        (assessment.gaps?.length > 0
          ? `Gaps Identified:\n${assessment.gaps.map(g => `• [${g.severity?.toUpperCase()}] ${g.description}`).join('\n')}`
          : 'No critical gaps identified.');

      // Merge with existing findings (prepend AI block)
      const existingFindings = req.findings && !req.findings.startsWith('[AI Evidence Review')
        ? `\n\n---\nPrevious findings:\n${req.findings}`
        : '';

      // ── Create ActionItems for gaps + update requirement in parallel ──
      const newActions = (assessment.corrective_actions || []).filter(action => {
        if (!action.action) return false;
        return !actionItemAlreadyExists(recentActionItems, req.id, action.action);
      });

      await Promise.all([
        base44.asServiceRole.entities.ComplianceRequirement.update(req.id, {
          findings: aiFindings + existingFindings,
        }),
        ...newActions.map(action =>
          base44.asServiceRole.entities.ActionItem.create({
            organization_id: req.organization_id,
            title: `[AI] ${req.clause_number}: ${action.action.slice(0, 80)}`,
            description: `Corrective action for ${req.clause_number} – ${req.clause_title}.\n\n${action.action}\n\nRationale: ${action.rationale || 'Identified by AI evidence review.'}`,
            source_type: 'compliance_audit',
            source_id: req.id,
            priority: action.priority || 'medium',
            status: 'pending',
            assigned_to: req.assigned_to || null,
            clause_reference: req.clause_number,
            related_requirement_id: req.id,
          })
        ),
      ]);

      actionsCreated += newActions.length;

      // ── Notify assigned person via email for high/critical gaps (fire-and-forget) ──
      const hasCriticalGaps = (assessment.gaps || []).some(g =>
        g.severity === 'critical' || g.severity === 'high'
      );

      if ((hasCriticalGaps || !assessment.has_sufficient_evidence) && (req.assigned_to || req.created_by)) {
        const recipient = req.assigned_to || req.created_by;
        const gapList = (assessment.gaps || []).slice(0, 5).map(g => `• [${g.severity?.toUpperCase()}] ${g.description}`).join('\n');
        const actionList = (assessment.corrective_actions || []).slice(0, 3).map((a, i) => `${i + 1}. ${a.action}`).join('\n');

        // Intentionally NOT awaited — fire and forget to avoid timeout
        base44.asServiceRole.integrations.Core.SendEmail({
          to: recipient,
          subject: `⚠️ Evidence Gaps: ${req.clause_number} – ${req.clause_title}`,
          body: `Evidence gaps were detected for ${req.clause_number} – ${req.clause_title}.\n\nEvidence Score: ${assessment.evidence_quality_score ?? 'N/A'}/100\n\n${assessment.summary || ''}\n\nGaps:\n${gapList}\n\nRecommended Actions:\n${actionList}\n\nLog in to the FSMS Compliance Tracker to review findings and upload missing evidence.`,
        }).catch(() => {}); // swallow errors — non-critical
      }

      results.push({
        requirement_id: req.id,
        clause: req.clause_number,
        verdict: assessment.verdict,
        evidence_score: assessment.evidence_quality_score,
        gaps: assessment.gaps?.length || 0,
        actions_created: assessment.corrective_actions?.length || 0,
        docs_reviewed: linkedDocs.length,
      });

      processed++;
    }

    console.log(`aiEvidenceComplianceAnalyzer: processed=${processed}, skipped=${skipped}, actions_created=${actionsCreated}`);

    return Response.json({
      success: true,
      run_date: today,
      processed,
      skipped_recently_analyzed: skipped,
      action_items_created: actionsCreated,
      results,
    });

  } catch (error) {
    console.error('aiEvidenceComplianceAnalyzer error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});