import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();

    const batch = payload.data;
    const batchId = payload.event?.entity_id;

    if (!batch) {
      return Response.json({ error: 'No batch data in payload' }, { status: 400 });
    }

    const audit = await base44.asServiceRole.entities.ComplianceAudit.create({
      organization_id: batch.organization_id,
      audit_date: new Date().toISOString(),
      status: 'in_progress',
      summary: `Quality deviation detected for raw material batch: ${batch.batch_number || batchId}. Material: ${batch.material_name || 'N/A'}, Supplier: ${batch.supplier || 'N/A'}.`,
      findings: [
        {
          clause_number: '8.5.4',
          issue_type: 'quality_deviation',
          severity: 'high',
          description: `Batch ${batch.batch_number || batchId} (${batch.material_name || 'Unknown material'}) from supplier ${batch.supplier || 'Unknown'} has been flagged with a quality deviation.`,
          recommendation: 'Quarantine batch, investigate root cause, and complete corrective action before further use.',
        }
      ],
      recommendations: [
        `Quarantine batch ${batch.batch_number || batchId} immediately`,
        'Conduct root cause analysis for quality deviation',
        'Notify supplier and request corrective action report',
        'Review incoming inspection procedures for this material',
      ],
    });

    return Response.json({
      success: true,
      audit_id: audit.id,
      batch_number: batch.batch_number,
    });

  } catch (error) {
    console.error('Audit on quality deviation error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});