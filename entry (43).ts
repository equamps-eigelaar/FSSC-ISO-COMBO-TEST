import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const body = await req.json();
    const batch = body.data;

    if (!batch) {
      return Response.json({ error: 'No batch data provided' }, { status: 400 });
    }

    const today = new Date().toISOString().split('T')[0];

    const audit = await base44.asServiceRole.entities.ComplianceAudit.create({
      organization_id: batch.organization_id,
      audit_date: new Date().toISOString(),
      status: 'in_progress',
      overall_score: 0,
      summary: `Quality deviation detected for raw material batch: ${batch.batch_number} – ${batch.material_name} (Supplier: ${batch.supplier || 'Unknown'}).`,
      findings: [
        {
          clause_number: '7.1.6',
          issue_type: 'Quality Deviation',
          severity: 'high',
          description: `Batch ${batch.batch_number} (${batch.material_name}) from supplier "${batch.supplier || 'Unknown'}" was flagged as rejected/quality deviation on ${today}.`,
          recommendation: 'Quarantine batch, conduct root cause analysis, notify supplier, and initiate corrective action.'
        }
      ],
      recommendations: [
        `Quarantine batch ${batch.batch_number} immediately.`,
        `Conduct root cause analysis for material: ${batch.material_name}.`,
        `Notify supplier "${batch.supplier || 'Unknown'}" of the deviation.`,
        `Review and update supplier risk rating.`,
        `Document corrective and preventive actions (CAPA).`
      ],
      risk_summary: {
        critical: 0,
        high: 1,
        medium: 0,
        low: 0
      },
      metrics: {
        total_requirements: 1,
        compliant: 0,
        non_compliant: 1,
        in_progress: 0,
        missing_evidence: 1,
        overdue: 0
      }
    });

    // Log the activity
    await base44.asServiceRole.entities.ActivityLog.create({
      activity_type: 'system_event',
      entity_type: 'ComplianceAudit',
      entity_id: audit.id,
      entity_label: `Batch ${batch.batch_number}`,
      description: `Auto-created compliance audit for quality deviation on batch ${batch.batch_number} (${batch.material_name})`,
      user_email: 'system@automation'
    });

    // Notify admins
    const adminUsers = await base44.asServiceRole.entities.User.filter({ role: 'admin' });
    for (const admin of adminUsers) {
      if (!admin.email) continue;
      await base44.asServiceRole.integrations.Core.SendEmail({
        to: admin.email,
        subject: `⚠️ Quality Deviation Detected – Batch ${batch.batch_number}`,
        body: `
          <h2>Quality Deviation – Raw Material Batch Alert</h2>
          <p>A compliance audit has been automatically created for the following batch:</p>
          <ul>
            <li><strong>Batch Number:</strong> ${batch.batch_number}</li>
            <li><strong>Material:</strong> ${batch.material_name}</li>
            <li><strong>Supplier:</strong> ${batch.supplier || 'Unknown'}</li>
            <li><strong>Date Flagged:</strong> ${today}</li>
          </ul>
          <p>Please review the audit in the <strong>AI Audits</strong> section of the FSMS Compliance Tracker and take appropriate corrective action.</p>
          <hr/>
          <p><small>This alert was generated automatically by the FSMS Compliance System.</small></p>
        `
      });
    }

    return Response.json({
      success: true,
      audit_id: audit.id,
      batch_number: batch.batch_number
    });

  } catch (error) {
    console.error('Quality deviation audit error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});