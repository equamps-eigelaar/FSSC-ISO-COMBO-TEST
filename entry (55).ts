import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { assessment_id, recipient_email, message } = await req.json();
    if (!assessment_id || !recipient_email) {
      return Response.json({ error: 'assessment_id and recipient_email required' }, { status: 400 });
    }

    const assessments = await base44.entities.SupplierSelfAssessment.filter({ id: assessment_id });
    const a = assessments[0];
    if (!a) return Response.json({ error: 'Assessment not found' }, { status: 404 });

    // Build HTML summary of results
    const ratingColors = { low: '#16a34a', medium: '#d97706', high: '#ea580c', critical: '#dc2626' };
    const ratingColor = ratingColors[a.risk_rating] || '#6b7280';

    const sectionsHtml = (a.sections || []).map(section => {
      const qs = (section.questions || []).map(q => {
        const answerLabel = { yes: '✅ Yes', no: '❌ No', partial: '⚠️ Partial', na: '➖ N/A' }[q.user_answer || q.ai_answer] || '-';
        return `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:13px;">${q.question}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center;">${answerLabel}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b;">${q.comments || ''}</td>
        </tr>`;
      }).join('');
      return `<h3 style="color:#1e293b;margin:20px 0 8px;">${section.section_title}</h3>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;margin-bottom:16px;">
          <thead><tr style="background:#f8fafc;">
            <th style="padding:8px;text-align:left;font-size:13px;color:#475569;">Question</th>
            <th style="padding:8px;text-align:center;font-size:13px;color:#475569;width:100px;">Answer</th>
            <th style="padding:8px;text-align:left;font-size:13px;color:#475569;">Comments</th>
          </tr></thead>
          <tbody>${qs}</tbody>
        </table>`;
    }).join('');

    const gapsHtml = (a.ai_gaps || []).map(g => `<li style="margin-bottom:4px;font-size:13px;">${g}</li>`).join('');
    const recsHtml = (a.ai_recommendations || []).map(r => `<li style="margin-bottom:4px;font-size:13px;">${r}</li>`).join('');

    const emailBody = `
<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;background:#f8fafc;padding:20px;">
  <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:20px;">
    <h1 style="color:#0f172a;margin:0 0 4px;">Supplier Self-Assessment Report</h1>
    <p style="color:#64748b;margin:0 0 24px;">${a.customer_name} — ${a.title}</p>

    <div style="display:flex;gap:16px;margin-bottom:24px;">
      <div style="background:#f1f5f9;border-radius:8px;padding:16px;flex:1;text-align:center;">
        <div style="font-size:36px;font-weight:bold;color:${ratingColor};">${Math.round(a.risk_score || 0)}%</div>
        <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Compliance Score</div>
      </div>
      <div style="background:#f1f5f9;border-radius:8px;padding:16px;flex:1;text-align:center;">
        <div style="font-size:24px;font-weight:bold;color:${ratingColor};text-transform:uppercase;">${a.risk_rating || '-'}</div>
        <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Risk Rating</div>
      </div>
      <div style="background:#f1f5f9;border-radius:8px;padding:16px;flex:2;">
        <div style="font-size:12px;color:#64748b;margin-bottom:4px;">Completed by</div>
        <div style="font-size:13px;font-weight:500;">${a.assigned_to || user.email}</div>
        <div style="font-size:12px;color:#64748b;margin-top:8px;">Date</div>
        <div style="font-size:13px;">${new Date().toLocaleDateString('en-ZA', { year:'numeric', month:'long', day:'numeric' })}</div>
      </div>
    </div>

    ${a.ai_summary ? `<div style="background:#f0fdf4;border-left:4px solid #16a34a;padding:16px;border-radius:0 8px 8px 0;margin-bottom:24px;">
      <p style="margin:0;font-size:14px;color:#166534;">${a.ai_summary}</p>
    </div>` : ''}

    ${message ? `<div style="background:#eff6ff;border-radius:8px;padding:16px;margin-bottom:24px;">
      <p style="margin:0 0 4px;font-size:12px;color:#3b82f6;font-weight:600;">MESSAGE FROM ${user.full_name?.toUpperCase() || user.email.toUpperCase()}</p>
      <p style="margin:0;font-size:13px;">${message}</p>
    </div>` : ''}
  </div>

  ${(a.ai_gaps?.length || a.ai_recommendations?.length) ? `
  <div style="background:#fff;border-radius:12px;padding:24px;margin-bottom:20px;">
    ${gapsHtml ? `<h2 style="color:#0f172a;margin:0 0 12px;font-size:16px;">Key Compliance Gaps</h2><ul style="margin:0 0 20px;padding-left:20px;">${gapsHtml}</ul>` : ''}
    ${recsHtml ? `<h2 style="color:#0f172a;margin:0 0 12px;font-size:16px;">Recommendations</h2><ul style="margin:0;padding-left:20px;">${recsHtml}</ul>` : ''}
  </div>` : ''}

  <div style="background:#fff;border-radius:12px;padding:24px;">
    <h2 style="color:#0f172a;margin:0 0 16px;font-size:16px;">Detailed Assessment</h2>
    ${sectionsHtml}
  </div>

  <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:20px;">
    Generated by CTP Flexibles Compliance Tracker · ${new Date().toISOString()}
  </p>
</div>`;

    await base44.integrations.Core.SendEmail({
      to: recipient_email,
      subject: `Supplier Self-Assessment: ${a.title} — ${Math.round(a.risk_score || 0)}% Compliance`,
      body: emailBody,
      from_name: 'CTP Flexibles Compliance'
    });

    // Update status to submitted
    await base44.asServiceRole.entities.SupplierSelfAssessment.update(assessment_id, {
      status: 'submitted',
      completed_date: new Date().toISOString(),
      submitted_to: recipient_email
    });

    return Response.json({ success: true });

  } catch (error) {
    console.error('emailSelfAssessment error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});